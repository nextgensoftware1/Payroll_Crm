import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type Ctx, today } from "../context.ts";
import { AppError } from "../errors.ts";
import { configValue } from "./dashboard.ts";
import { myMonthReport } from "./reports.ts";

/** Employee self-service requests. Always decided by an Admin: they are
 *  never auto-approved, even in single-admin mode. */

const mustBeLinked = (ctx: Ctx) => {
  if (!ctx.employeeId) throw new AppError(403, "not_linked", "Your login isn't linked to an employee record. Ask HR.");
  return ctx.employeeId;
};
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** A locked month's payroll is final: changing it needs an Admin to reopen payroll first. */
async function refuseIfPayrollLocked(ctx: Ctx, from: string, to: string) {
  const [m] = await ctx.tx<{ month: string }[]>`select to_char(period_month, 'FMMonth YYYY') as month
    from hr.payroll_period pp where daterange(pp.starts_on, pp.ends_on, '[]') && daterange(${from}::date, ${to}::date, '[]')
      and hr.period_is_locked(pp.id) limit 1`;
  if (m) throw new AppError(409, "payroll_locked", `${m.month} payroll is already locked. Ask HR or an Admin: they can reopen it if this needs correcting.`);
}

async function openApproval(ctx: Ctx, kind: "leave" | "attendance_correction", subject: string, table: string, empId: string, reason: string) {
  const approvalId = randomUUID();
  await ctx.tx`insert into hr.approval_request (id, kind, subject_table, subject_id, subject_employee_id, required_role, reason)
               values (${approvalId}, ${kind}::hr.approval_kind, ${table}, ${subject}, ${empId}, 'admin', ${reason})`;
  return approvalId;
}

export const LeaveInput = z.object({
  leave_type: z.enum(["ANNUAL", "SICK", "CASUAL", "UNPAID"]),
  start_date: z.iso.date("Choose the first day."),
  end_date: z.iso.date("Choose the last day."),
  part_of_day: z.enum(["full", "first_half", "second_half"]).default("full"),
  reason: z.string().trim().min(3, "Say briefly why (it is shown to the Admin)."),
});

export async function requestLeave(ctx: Ctx, input: z.input<typeof LeaveInput>) {
  const empId = mustBeLinked(ctx);
  const d = LeaveInput.parse(input);
  if (d.end_date < d.start_date) throw new AppError(422, "dates", "The last day is before the first day.");
  if (days(d.start_date, d.end_date) > 30) throw new AppError(422, "too_long", "A single request can cover at most 31 days.");
  if (d.part_of_day !== "full" && d.start_date !== d.end_date) throw new AppError(422, "half_day", "A half day must be a single date.");
  await refuseIfPayrollLocked(ctx, d.start_date, d.end_date);
  const [clash] = await ctx.tx<{ s: string; e: string }[]>`
    select lr.start_date as s, lr.end_date as e from hr.leave_request lr join hr.approval_request ar on ar.id = lr.approval_request_id
    where lr.employee_id = ${empId} and ar.status in ('pending', 'approved')
      and daterange(lr.start_date, lr.end_date, '[]') && daterange(${d.start_date}::date, ${d.end_date}::date, '[]')`;
  if (clash) throw new AppError(409, "overlap", `You already have leave requested or approved from ${clash.s} to ${clash.e}.`);
  const [type] = await ctx.tx<{ id: string; name: string }[]>`select id, name from hr.leave_type where code = ${d.leave_type}`;
  if (!type) throw new AppError(422, "no_type", "That leave type isn't set up. Ask HR.");
  const leaveId = randomUUID();
  const nice = (x: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${x}T00:00:00Z`));
  const span = d.start_date === d.end_date ? nice(d.start_date) : `${nice(d.start_date)} to ${nice(d.end_date)}`;
  const approvalId = await openApproval(ctx, "leave", leaveId, "leave_request", empId, `${type.name}, ${span}${d.part_of_day !== "full" ? ` (${d.part_of_day.replace("_", " ")})` : ""}: ${d.reason}`);
  await ctx.tx`insert into hr.leave_request (id, employee_id, leave_type_id, start_date, end_date, part_of_day, reason, approval_request_id)
               values (${leaveId}, ${empId}, ${type.id}, ${d.start_date}, ${d.end_date}, ${d.part_of_day}, ${d.reason}, ${approvalId})`;
  await ctx.tx`select hr.notify_admins_of_request(${approvalId}, ${"Leave request"}, ${`${type.name}, ${span}`})`;
  return approvalId;
}

export const ExcuseInput = z.object({
  kind: z.enum(["late", "missing_punch"]),
  business_date: z.iso.date("Choose the day."),
  reason: z.string().trim().min(3, "Explain briefly; the Admin sees this."),
  punch_time: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),     // missing_punch: HH:MM they clocked
  punch_next_day: z.boolean().optional(),                                   // e.g. a 02:05 clock-out after midnight
});

/** "I was late because…" or "I forgot to punch". Checked against the
 *  employee's own attendance so only real cases can be filed. */
export async function requestExcuse(ctx: Ctx, input: z.input<typeof ExcuseInput>) {
  const empId = mustBeLinked(ctx);
  const d = ExcuseInput.parse(input);
  await refuseIfPayrollLocked(ctx, d.business_date, d.business_date);
  const rep = await myMonthReport(ctx, d.business_date.slice(0, 7));
  const day = rep.person?.result.days.find((x) => x.date === d.business_date);
  if (!day) throw new AppError(404, "no_day", "No attendance found for that day.");
  if (d.kind === "late" && day.status !== "late") throw new AppError(409, "not_late", "That day isn't marked late, so there is nothing to explain.");
  if (d.kind === "missing_punch" && day.status !== "incomplete") throw new AppError(409, "not_incomplete", "That day isn't missing a punch.");
  let added: string | null = null;
  if (d.kind === "missing_punch") {
    if (!d.punch_time) throw new AppError(422, "time", "Enter the time you clocked in or out.");
    const base = new Date(`${d.business_date}T00:00:00Z`);
    if (d.punch_next_day) base.setUTCDate(base.getUTCDate() + 1);
    added = `${base.toISOString().slice(0, 10)}T${d.punch_time}:00`;
    if (day.firstIn && Math.abs(Date.parse(`${added}Z`) - Date.parse(`${day.firstIn}Z`)) < 30 * 60000)
      throw new AppError(422, "too_close", "That time is within 30 minutes of the punch already recorded. Check the time and day.");
  }
  const [dup] = await ctx.tx`
    select 1 from hr.attendance_excuse x join hr.approval_request ar on ar.id = x.approval_request_id
    where x.employee_id = ${empId} and x.business_date = ${d.business_date} and x.kind = ${d.kind} and ar.status in ('pending', 'approved')`;
  if (dup) throw new AppError(409, "duplicate", "You already have a request for that day waiting or approved.");
  const window = Number((await configValue(ctx.tx, "attendance.dispute_window_days", today()))?.value ?? 3);
  const lateFiling = days(d.business_date, today()) > window;
  const excuseId = randomUUID();
  const what = d.kind === "late" ? `Late ${day.lateMinutes} min on ${d.business_date}` : `Missing punch on ${d.business_date}: add ${added!.replace("T", " ").slice(0, 16)}`;
  const approvalId = await openApproval(ctx, "attendance_correction", excuseId, "attendance_excuse", empId,
    `${what}: ${d.reason}${lateFiling ? ` (filed after the ${window}-day window)` : ""}`);
  await ctx.tx`insert into hr.attendance_excuse (id, employee_id, business_date, kind, reason, added_punch_local, late_filing, approval_request_id)
               values (${excuseId}, ${empId}, ${d.business_date}, ${d.kind}, ${d.reason}, ${added}, ${lateFiling}, ${approvalId})`;
  await ctx.tx`select hr.notify_admins_of_request(${approvalId}, ${d.kind === "late" ? "Late explanation" : "Missing punch fix"}, ${what})`;
  return approvalId;
}

export type MyRequest = { id: string; kind: string; title: string; detail: string; status: string; requested_at: string;
  decided_at: string | null; decision_reason: string | null; late_filing: boolean; from_date: string; to_date: string };

export async function myRequests(ctx: Ctx): Promise<MyRequest[]> {
  const empId = mustBeLinked(ctx);
  return ctx.tx<MyRequest[]>`
    select * from (
      select ar.id, 'leave' as kind, lt.name || ', ' || case when lr.start_date = lr.end_date then to_char(lr.start_date, 'DD Mon YYYY')
             else to_char(lr.start_date, 'DD Mon') || ' to ' || to_char(lr.end_date, 'DD Mon YYYY') end as title,
             coalesce(lr.reason, '') as detail, ar.status::text as status, ar.requested_at, ar.decided_at, d.reason as decision_reason, false as late_filing,
             lr.start_date as from_date, lr.end_date as to_date
      from hr.leave_request lr join hr.leave_type lt on lt.id = lr.leave_type_id
      join hr.approval_request ar on ar.id = lr.approval_request_id left join hr.approval_decision d on d.approval_request_id = ar.id
      where lr.employee_id = ${empId}
      union all
      select ar.id, x.kind, case x.kind when 'late' then 'Late arrival, ' else 'Missing punch, ' end || to_char(x.business_date, 'DD Mon YYYY'),
             x.reason || coalesce(' (time: ' || to_char(x.added_punch_local, 'HH24:MI') || ')', ''), ar.status::text, ar.requested_at, ar.decided_at, d.reason, x.late_filing,
             x.business_date, x.business_date
      from hr.attendance_excuse x join hr.approval_request ar on ar.id = x.approval_request_id
      left join hr.approval_decision d on d.approval_request_id = ar.id
      where x.employee_id = ${empId}
    ) r order by requested_at desc limit 50`;
}
