import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type Ctx, requireRole } from "../context.ts";
import { AppError, notFound } from "../errors.ts";

/** Approvals centre. The decision INSERT is where the real checks happen
 *  (hr.on_approval_decision trigger: role, segregation of duties, pending
 *  only, kind-specific guards). After approval, APPLIERS move the subject
 *  row's own status in the same transaction. */

export type Approval = {
  id: string; kind: string; status: "pending" | "approved" | "rejected"; required_role: string; reason: string;
  requested_at: string; requested_by_name: string | null; subject_table: string; subject_id: string;
  subject_employee_id: string | null; subject_employee_name: string | null; subject: Record<string, unknown> | null;
  decision_reason: string | null; decided_at: string | null; can_decide: boolean;
};

export async function listApprovals(ctx: Ctx, f: { status?: string | null; mine?: boolean; limit?: number } = {}): Promise<Approval[]> {
  return ctx.tx<Approval[]>`
    select r.id, r.kind::text as kind, r.status::text as status, r.required_role::text as required_role, r.reason,
           r.requested_at, req.full_name as requested_by_name, r.subject_table, r.subject_id,
           r.subject_employee_id, se.full_name as subject_employee_name, d.reason as decision_reason, r.decided_at,
           (r.status = 'pending' and r.requested_by <> hr.current_auth_user() and hr.has_role(r.required_role)) as can_decide,
           case r.kind
             when 'punch_mapping' then (
               select jsonb_build_object('enrollment_no', pm.enrollment_no, 'name_in_file', pm.expected_name,
                                         'employee', e.full_name, 'from', lower(pm.valid_during), 'device', dv.name)
               from hr.punch_mapping pm join hr.employee e on e.id = pm.employee_id join hr.device dv on dv.id = pm.device_id
               where pm.id = r.subject_id)
             when 'policy_config' then (
               select jsonb_build_object('setting', pc.key, 'value', pc.value, 'from', lower(pc.valid_during), 'source', pc.source_reference)
               from hr.policy_config pc where pc.id = r.subject_id)
             when 'holiday' then (
               select jsonb_build_object('date', h.holiday_date, 'name', h.name, 'applies_to_all', h.applies_to_all)
               from hr.holiday h where h.id = r.subject_id)
             when 'deduction' then (
               select jsonb_build_object('type', dp.kind, 'month', dp.applies_to_month, 'basis', dp.basis_explanation)
               from hr.deduction_proposal dp where dp.id = r.subject_id)
           end as subject
    from hr.approval_request r
    left join hr.approval_decision d on d.approval_request_id = r.id
    left join hr.employee req on req.auth_user_id = r.requested_by
    left join hr.employee se on se.id = r.subject_employee_id
    where (${f.status ?? null}::text is null or r.status::text = ${f.status ?? null}::text)
      and (not ${f.mine ?? false}::boolean or (r.status = 'pending' and r.requested_by <> hr.current_auth_user() and hr.has_role(r.required_role)))
    order by r.status = 'pending' desc, r.requested_at desc
    limit ${Math.min(f.limit ?? 100, 200)}`;
}

// Kinds whose subject carries its own status. Everything else derives its
// effect from hr.is_approved(approval_request_id).
const APPLIERS: Record<string, (ctx: Ctx, status: string, id: string) => Promise<void>> = {
  punch_mapping: async (c, st, id) => { await c.tx`update hr.punch_mapping set status = ${st}::hr.config_status where id = ${id}`; },
  policy_config: async (c, st, id) => {
    if (st === "approved") {
      // keep history: the previous value stops where the new one starts
      await c.tx`update hr.policy_config o set status = 'retired' from hr.policy_config n
                 where n.id = ${id} and o.key = n.key and o.id <> n.id and o.status = 'approved' and lower(o.valid_during) >= lower(n.valid_during)`;
      await c.tx`update hr.policy_config o set valid_during = daterange(lower(o.valid_during), lower(n.valid_during)) from hr.policy_config n
                 where n.id = ${id} and o.key = n.key and o.id <> n.id and o.status = 'approved' and o.valid_during @> lower(n.valid_during)`;
    }
    await c.tx`update hr.policy_config set status = ${st}::hr.config_status where id = ${id}`;
  },
  holiday: async (c, st, id) => { await c.tx`update hr.holiday set status = ${st}::hr.config_status where id = ${id}`; },
  document_requirement: async (c, st, id) => { await c.tx`update hr.document_requirement set status = ${st}::hr.config_status where id = ${id}`; },
  compensation_change: async (c, st, id) => {
    if (st === "approved") {
      await c.tx`update hr.compensation_plan o set status = 'retired' from hr.compensation_plan n
                 where n.id = ${id} and o.employee_id = n.employee_id and o.id <> n.id and o.status = 'approved' and lower(o.valid_during) >= lower(n.valid_during)`;
      await c.tx`update hr.compensation_plan o set valid_during = daterange(lower(o.valid_during), lower(n.valid_during)) from hr.compensation_plan n
                 where n.id = ${id} and o.employee_id = n.employee_id and o.id <> n.id and o.status = 'approved' and o.valid_during @> lower(n.valid_during)`;
    }
    await c.tx`update hr.compensation_plan set status = ${st}::hr.config_status where id = ${id} and status = 'proposed'`;
  },
};

export const DecisionInput = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().min(3, "Give a reason. It is stored with the decision and can't be changed later."),
});

export async function decide(ctx: Ctx, approvalId: string, input: z.input<typeof DecisionInput>) {
  const d = DecisionInput.parse(input);
  if (!z.guid().safeParse(approvalId).success) throw notFound("Approval request");
  const [req] = await ctx.tx<{ kind: string; subject_id: string }[]>`
    select kind::text as kind, subject_id from hr.approval_request where id = ${approvalId}`;
  if (!req) throw notFound("Approval request");
  await ctx.tx`insert into hr.approval_decision (approval_request_id, decision, reason) values (${approvalId}, ${d.decision}, ${d.reason})`;
  await APPLIERS[req.kind]?.(ctx, d.decision === "approved" ? "approved" : "rejected", req.subject_id);
}

/** Single-admin mode (owner decision): when ON, requests are approved
 *  straight away by the System actor, through the same database checks. */
export async function singleAdminMode(ctx: Ctx): Promise<boolean> {
  const [r] = await ctx.tx<{ on: boolean }[]>`select hr.flag_enabled('single_admin_mode') as on`;
  return Boolean(r?.on);
}

/** Approve now if single-admin mode is on; otherwise leave it for a second Admin.
 *  Returns true when the request was approved immediately. */
export async function approveNowIfAllowed(ctx: Ctx, approvalId: string, reason: string): Promise<boolean> {
  if (!(await singleAdminMode(ctx))) return false;
  const [req] = await ctx.tx<{ kind: string; subject_id: string }[]>`
    select kind::text as kind, subject_id from hr.approval_request where id = ${approvalId}`;
  await ctx.tx`select hr.auto_decide(${approvalId}, ${reason})`;
  await APPLIERS[req!.kind]?.(ctx, "approved", req!.subject_id);
  return true;
}

/** Approve every request waiting for this person, one by one. Each still
 *  passes the database's role and segregation-of-duties checks; a failure
 *  on one (savepoint) doesn't block the others. */
export async function approveAllMine(ctx: Ctx, reason: string) {
  const r = reason.trim();
  if (r.length < 3) throw new AppError(422, "reason_required", "Give a reason. It is stored with every decision.");
  const items = (await listApprovals(ctx, { mine: true, limit: 200 })).filter((a) => a.kind !== "deduction");
  const failed: { id: string; kind: string; message: string }[] = [];
  let approved = 0;
  for (const a of items) {
    try {
      await ctx.tx.savepoint((sp) => decide({ ...ctx, tx: sp as unknown as Ctx["tx"] }, a.id, { decision: "approved", reason: r }));
      approved++;
    } catch (e) {
      failed.push({ id: a.id, kind: a.kind, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return { approved, failed };
}

export type ConfigRow = { id: string; key: string; value: unknown; valid_from: string | null; valid_to: string | null; status: string;
  pending_legal_review: boolean; source_reference: string; approval_request_id: string | null };

export async function listConfig(ctx: Ctx): Promise<ConfigRow[]> {
  requireRole(ctx, "admin", "hr");
  return ctx.tx<ConfigRow[]>`
    select id, key, value, lower(valid_during) as valid_from, upper(valid_during) as valid_to, status::text as status, pending_legal_review,
           source_reference, approval_request_id
    from hr.policy_config order by key, lower(valid_during) desc`;
}

/** Send a proposed policy row (e.g. the 10-minute grace period) to an Admin. */
export async function submitConfig(ctx: Ctx, configId: string) {
  requireRole(ctx, "admin", "hr");
  const [row] = await ctx.tx<{ status: string; approval_request_id: string | null }[]>`
    select status::text as status, approval_request_id from hr.policy_config where id = ${configId}`;
  if (!row) throw notFound("Setting");
  if (row.status !== "proposed" || row.approval_request_id) throw new AppError(409, "already_submitted", "This setting is already submitted or decided.");
  const approvalId = randomUUID();
  await ctx.tx`insert into hr.approval_request (id, kind, subject_table, subject_id, required_role, reason)
               values (${approvalId}, 'policy_config', 'policy_config', ${configId}, 'admin', 'Activate policy value')`;
  await ctx.tx`update hr.policy_config set approval_request_id = ${approvalId} where id = ${configId}`;
  await approveNowIfAllowed(ctx, approvalId, "setting activated");
  return approvalId;
}

export const CONFIG_LIMITS: Record<string, [number, number]> = {
  "attendance.grace_minutes": [0, 120], "attendance.late_penalty_percent_of_day": [0, 100],
  "payroll.working_days_divisor": [1, 31], "attendance.absence_penalty_days": [0, 3],
  "attendance.near_duplicate_seconds": [0, 600], "attendance.dispute_window_days": [0, 60],
  "alerts.probation_contract_lead_days": [1, 90],
};

/** Change a rule's value from a given date. The old value is kept for the
 *  months before (history is never overwritten); the new row is approved
 *  straight away in single-admin mode, otherwise it waits for a second Admin. */
export async function changeConfig(ctx: Ctx, key: string, value: number, from: string) {
  requireRole(ctx, "admin", "hr");
  const lim = CONFIG_LIMITS[key];
  if (!lim) throw new AppError(422, "unknown_setting", "That setting can't be changed here.");
  if (!Number.isFinite(value) || value < lim[0] || value > lim[1]) throw new AppError(422, "out_of_range", `Use a value from ${lim[0]} to ${lim[1]}.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new AppError(422, "bad_date", "Choose the date it applies from.");
  const id = randomUUID(), approvalId = randomUUID();
  await ctx.tx`insert into hr.approval_request (id, kind, subject_table, subject_id, required_role, reason)
               values (${approvalId}, 'policy_config', 'policy_config', ${id}, 'admin', ${`Change ${key} to ${value} from ${from}`})`;
  await ctx.tx`insert into hr.policy_config (id, key, value, valid_during, status, source_reference, approval_request_id)
               values (${id}, ${key}, ${ctx.tx.json(value)}, daterange(${from}::date, null), 'proposed',
                       ${`Changed in Settings by ${ctx.principal.email ?? "staff"}`}, ${approvalId})`;
  return approveNowIfAllowed(ctx, approvalId, `setting changed to ${value}`);
}
