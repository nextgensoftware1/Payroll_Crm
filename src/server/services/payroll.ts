import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type Ctx, requireRole } from "../context.ts";
import { AppError, notFound } from "../errors.ts";
import { approveNowIfAllowed, singleAdminMode } from "./approvals.ts";
import { monthReport } from "./reports.ts";

/** Monthly payroll: calculate -> (review) -> approve and LOCK -> payslips.
 *
 *  gross   = monthly salary; for someone who joined/left mid-month:
 *            a day's salary x working days employed
 *  cuts    = late days x 4% of a day + absent days x 1 day (owner rules),
 *            never more than gross. "Needs review" days are never cut.
 *  net     = gross - cuts. Tax is NOT calculated (rates not verified).
 *  Locking writes an insert-only snapshot; later uploads never change it.
 *  Paying people happens at the bank; the app records no payments. */

export const ENGINE_VERSION = "pay-rules/2026-10-19";
const MONTH = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Choose a month.");

export type PayLine = {
  id: string; employee_id: string; employee_code: string; full_name: string; base_monthly_paisa: number;
  gross_paisa: number; total_deductions_paisa: number; net_paisa: number; scheduled_days: number; eligible_days: string;
  components: { kind: string; days?: number; minutes?: number; amount_paisa: number; note?: string }[];
  exceptions_snapshot: { kind: string; days?: number; note?: string }[];
};
export type Run = { id: string; version: number; status: string; prepared_at: string; reopen_reason: string | null; period_id: string };

async function ensurePeriod(ctx: Ctx, month: string): Promise<string> {
  const start = `${month}-01`;
  await ctx.tx`insert into hr.payroll_period (period_month, starts_on, ends_on)
               values (${start}::date, ${start}::date, (${start}::date + interval '1 month' - interval '1 day')::date)
               on conflict (period_month) do nothing`;
  const [p] = await ctx.tx<{ id: string }[]>`select id from hr.payroll_period where period_month = ${start}::date`;
  return p!.id;
}

async function currentRun(ctx: Ctx, periodId: string): Promise<Run | null> {
  const [r] = await ctx.tx<Run[]>`
    select id, version, status::text as status, prepared_at, reopen_reason, period_id from hr.payroll_run
    where period_id = ${periodId} and not is_sandbox and status <> 'superseded' order by version desc limit 1`;
  return r ?? null;
}

/** Create or refresh the DRAFT run for a month from the live attendance report. */
export async function calculate(ctx: Ctx, monthInput: string) {
  requireRole(ctx, "admin", "hr");
  const month = MONTH.parse(monthInput);
  const periodId = await ensurePeriod(ctx, month);
  let run = await currentRun(ctx, periodId);
  if (run && run.status !== "draft")
    throw new AppError(409, "payroll_locked", run.status === "locked"
      ? "This month's payroll is locked. Reopen it to recalculate (the locked version is kept)."
      : "This month's payroll is waiting for approval. Send it back to draft to recalculate.");
  if (!run) {
    const [r] = await ctx.tx<Run[]>`
      insert into hr.payroll_run (period_id, version, is_sandbox, engine_version) values (${periodId}, 1, false, ${ENGINE_VERSION})
      returning id, version, status::text as status, prepared_at, reopen_reason, period_id`;
    run = r!;
  }
  const rep = await monthReport(ctx, { month });
  const seen = new Set<string>();
  let lines = 0;
  for (const p of rep.people) {
    if (p.salary_paisa === null) continue;
    const t = p.result.totals;
    // gross, cuts and net come from the attendance engine: the same numbers as Reports and the Overview
    const gross = t.grossPaisa!;
    const cuts = t.totalDeductionPaisa;
    const employed = t.employedDays, full = t.fullMonthDays, prorated = t.prorated;
    const components = [
      { kind: "salary", days: employed, amount_paisa: gross, note: prorated ? `${employed} of ${full} working days employed` : "full month" },
      ...(t.late ? [{ kind: "late", days: t.late, minutes: t.lateMinutes, amount_paisa: -t.lateDeductionPaisa, note: `${rep.policy.latePercentOfDay}% of a day each` }] : []),
      ...(t.absent ? [{ kind: "absence", days: t.absent, amount_paisa: -t.absenceDeductionPaisa, note: `${rep.policy.absenceDays} day each` }] : []),
      ...(t.unpaidLeave ? [{ kind: "unpaid_leave", days: t.unpaidLeave, amount_paisa: -t.unpaidLeaveDeductionPaisa, note: "approved unpaid leave" }] : []),
    ];
    const exceptions = [
      ...(t.leave ? [{ kind: "leave", days: t.leave, note: `${t.leave} day${t.leave === 1 ? "" : "s"} approved leave, not deducted` }] : []),
      ...(t.excused ? [{ kind: "excused", days: t.excused, note: `${t.excused} late day${t.excused === 1 ? "" : "s"} excused, not deducted` }] : []),
      ...(t.holiday ? [{ kind: "holiday", days: t.holiday, note: `${t.holiday} public holiday${t.holiday === 1 ? "" : "s"}, paid` }] : []),
      ...(t.incomplete ? [{ kind: "needs_review", days: t.incomplete, note: "single-punch days, not deducted" }] : []),
      ...(!p.shift ? [{ kind: "no_shift", note: "no shift set: lateness and absence not checked" }] : []),
      ...(p.salary_status !== "approved" ? [{ kind: "salary_not_approved", note: "salary still waiting for approval" }] : []),
    ];
    const eligible = Math.max(0, employed - t.absent);
    const row = { base: p.salary_paisa, gross, cuts, net: gross - cuts, sched: Math.max(1, full), elig: Math.min(eligible, Math.max(1, full)) };
    const upd = await ctx.tx`
      update hr.payroll_line set base_monthly_paisa = ${row.base}, prorated_base_paisa = ${row.gross}, gross_paisa = ${row.gross},
             total_deductions_paisa = ${row.cuts}, net_paisa = ${row.net}, scheduled_days = ${row.sched}, eligible_days = ${row.elig},
             components = ${ctx.tx.json(components)}, exceptions_snapshot = ${ctx.tx.json(exceptions)}
      where run_id = ${run.id} and employee_id = ${p.employee_id}`;
    if (!upd.count)
      await ctx.tx`
        insert into hr.payroll_line (run_id, employee_id, attendance_computation_ids, scheduled_days, eligible_days, base_monthly_paisa,
                                     prorated_base_paisa, components, gross_paisa, total_deductions_paisa, net_paisa, exceptions_snapshot)
        values (${run.id}, ${p.employee_id}, '{}', ${row.sched}, ${row.elig}, ${row.base}, ${row.gross}, ${ctx.tx.json(components)},
                ${row.gross}, ${row.cuts}, ${row.net}, ${ctx.tx.json(exceptions)})`;
    seen.add(p.employee_id);
    lines++;
  }
  // people who dropped out since the last calculation (e.g. salary removed): zeroed, never deleted
  const stale = await ctx.tx<{ employee_id: string }[]>`select employee_id from hr.payroll_line where run_id = ${run.id}`;
  for (const s of stale.filter((x) => !seen.has(x.employee_id)))
    await ctx.tx`update hr.payroll_line set gross_paisa = 0, prorated_base_paisa = 0, total_deductions_paisa = 0, net_paisa = 0, eligible_days = 0,
                 components = ${ctx.tx.json([{ kind: "excluded", amount_paisa: 0, note: "no salary for this month" }])}
                 where run_id = ${run.id} and employee_id = ${s.employee_id}`;
  return { runId: run.id, lines, missingSalary: rep.people.filter((p) => p.salary_paisa === null).map((p) => p.full_name) };
}

async function runOrThrow(ctx: Ctx, runId: string): Promise<Run> {
  if (!z.guid().safeParse(runId).success) throw notFound("Payroll run");
  const [r] = await ctx.tx<Run[]>`select id, version, status::text as status, prepared_at, reopen_reason, period_id from hr.payroll_run where id = ${runId}`;
  if (!r) throw notFound("Payroll run");
  return r;
}

export async function sendForReview(ctx: Ctx, runId: string) {
  requireRole(ctx, "admin", "hr");
  const r = await runOrThrow(ctx, runId);
  if (r.status !== "draft") throw new AppError(409, "not_draft", "Only a draft can be sent for approval.");
  await ctx.tx`update hr.payroll_run set status = 'under_review' where id = ${runId}`;
}

export async function backToDraft(ctx: Ctx, runId: string) {
  requireRole(ctx, "admin", "hr");
  const r = await runOrThrow(ctx, runId);
  if (r.status !== "under_review") throw new AppError(409, "not_in_review", "Only a payroll waiting for approval can go back to draft.");
  await ctx.tx`update hr.payroll_run set status = 'draft' where id = ${runId}`;
}

/** Admin approves the EXACT figures (line count, total, content hash) and locks. */
export async function approveAndLock(ctx: Ctx, runId: string, note: string) {
  requireRole(ctx, "admin");
  if (note.trim().length < 3) throw new AppError(422, "note_required", "Add a short note, for example \"August checked\".");
  const r = await runOrThrow(ctx, runId);
  if (r.status === "draft") await ctx.tx`update hr.payroll_run set status = 'under_review' where id = ${runId}`;
  else if (r.status !== "under_review") throw new AppError(409, "not_approvable", "This payroll is already approved or locked.");
  const [f] = await ctx.tx<{ line_count: number; total_net_paisa: string; content_hash: Buffer }[]>`select * from hr.payroll_run_fingerprint(${runId})`;
  if (!f!.line_count) throw new AppError(422, "empty", "There are no payroll lines. Set salaries, then calculate.");
  await ctx.tx`insert into hr.payroll_approval (run_id, approved_line_count, approved_total_net_paisa, approved_content_hash, note)
               values (${runId}, ${f!.line_count}, ${f!.total_net_paisa}, ${f!.content_hash}, ${note.trim()})`;
  await ctx.tx`select hr.lock_payroll_run(${runId})`;
}

/** Reopen a locked month: the locked version and its snapshot are kept; a new draft version starts. */
export async function reopen(ctx: Ctx, runId: string, reason: string) {
  requireRole(ctx, "admin");
  if (reason.trim().length < 5) throw new AppError(422, "reason_required", "Say why it's being reopened.");
  const r = await runOrThrow(ctx, runId);
  if (r.status !== "locked") throw new AppError(409, "not_locked", "Only a locked payroll can be reopened.");
  const approvalId = randomUUID();
  await ctx.tx`insert into hr.approval_request (id, kind, subject_table, subject_id, required_role, reason)
               values (${approvalId}, 'payroll_reopen', 'payroll_run', ${runId}, 'admin', ${reason.trim()})`;
  if (!(await approveNowIfAllowed(ctx, approvalId, "payroll reopened")))
    return { reopened: false as const };
  const [n] = await ctx.tx<{ id: string }[]>`select hr.reopen_payroll_run(${runId}, ${reason.trim()}, ${approvalId}) as id`;
  return { reopened: true as const, newRunId: n!.id };
}

export async function payrollMonth(ctx: Ctx, monthInput: string) {
  requireRole(ctx, "admin", "hr");
  const month = MONTH.parse(monthInput);
  const [period] = await ctx.tx<{ id: string }[]>`select id from hr.payroll_period where period_month = ${`${month}-01`}::date`;
  const runs = period ? await ctx.tx<Run[]>`
    select id, version, status::text as status, prepared_at, reopen_reason, period_id from hr.payroll_run
    where period_id = ${period.id} and not is_sandbox order by version desc` : [];
  const current = runs.find((r) => r.status !== "superseded") ?? null;
  const lines = current ? await linesOf(ctx, current.id) : [];
  const [appr] = current ? await ctx.tx<{ approved_at: string; note: string; approver: string | null }[]>`
    select a.approved_at, a.note, e.full_name as approver from hr.payroll_approval a
    left join hr.employee e on e.auth_user_id = a.approved_by where a.run_id = ${current.id}` : [];
  return { month, runs, current, lines, approval: appr ?? null, auto: await singleAdminMode(ctx) };
}

export async function linesOf(ctx: Ctx, runId: string): Promise<PayLine[]> {
  return ctx.tx<PayLine[]>`
    select l.id, l.employee_id, e.employee_code, e.full_name, l.base_monthly_paisa::bigint::float8 as base_monthly_paisa,
           l.gross_paisa::float8 as gross_paisa, l.total_deductions_paisa::float8 as total_deductions_paisa, l.net_paisa::float8 as net_paisa,
           l.scheduled_days, l.eligible_days::text, l.components, l.exceptions_snapshot
    from hr.payroll_line l join hr.employee e on e.id = l.employee_id
    where l.run_id = ${runId} order by e.employee_code`;
}

/** Payslip: staff for anyone; an employee only for their own LOCKED payslips (RLS). */
export async function payslip(ctx: Ctx, runId: string, employeeId: string) {
  if (!z.guid().safeParse(runId).success || !z.guid().safeParse(employeeId).success) throw notFound("Payslip");
  const [l] = await ctx.tx<(PayLine & { month: string; version: number; status: string; department: string | null; job_title: string | null })[]>`
    select l.id, l.employee_id, e.employee_code, e.full_name, l.base_monthly_paisa::float8 as base_monthly_paisa, l.gross_paisa::float8 as gross_paisa,
           l.total_deductions_paisa::float8 as total_deductions_paisa, l.net_paisa::float8 as net_paisa, l.scheduled_days, l.eligible_days::text,
           l.components, l.exceptions_snapshot, ri.month, ri.version, ri.status, d.name as department, a.job_title
    from hr.payroll_line l
    join hr.employee e on e.id = l.employee_id
    cross join lateral hr.run_info(l.run_id) ri
    left join lateral (select ea.department_id, ea.job_title from hr.employee_assignment ea
                       where ea.employee_id = e.id order by lower(ea.valid_during) desc limit 1) a on true
    left join hr.department d on d.id = a.department_id
    where l.run_id = ${runId} and l.employee_id = ${employeeId}`;
  if (!l) throw notFound("Payslip");
  return l;
}

export async function myPayslips(ctx: Ctx) {
  if (!ctx.employeeId) return [];
  return ctx.tx<{ run_id: string; net_paisa: number; month: string; version: number }[]>`
    select l.run_id, l.net_paisa::float8 as net_paisa, ri.month, ri.version
    from hr.payroll_line l cross join lateral hr.run_info(l.run_id) ri
    where l.employee_id = ${ctx.employeeId} and hr.run_is_final(l.run_id) order by ri.month desc`;
}
