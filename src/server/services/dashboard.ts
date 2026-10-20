import "server-only";
import { type Ctx, requireRole, today } from "../context.ts";
import type { Tx } from "../db.ts";

/** Approved value wins; a proposed value is returned with its status so
 *  callers can show that it is not yet approved. */
export async function configValue(tx: Tx, key: string, on: string) {
  const [row] = await tx<{ value: unknown; status: string }[]>`
    select value, status::text as status from hr.policy_config
    where key = ${key} and valid_during @> ${on}::date and status in ('approved', 'proposed')
    order by status = 'approved' desc, created_at desc limit 1`;
  return row ?? null;
}

export type Summary = {
  headcount_active: number; headcount_inactive: number; missing_documents: number; open_attendance_exceptions: number;
  open_import_flags: number; batches_under_review: number; pending_approvals: number; pending_my_decision: number;
  expiring: { employee_id: string; employee_code: string; full_name: string; kind: string; end_date: string; days_remaining: number }[];
};

export async function summary(ctx: Ctx): Promise<Summary> {
  requireRole(ctx, "admin", "hr");
  const t = today();
  const lead = Number((await configValue(ctx.tx, "alerts.probation_contract_lead_days", t))?.value ?? 15);
  const [s] = await ctx.tx<Omit<Summary, "expiring">[]>`
    select (select count(*) from hr.employee where status = 'active')::int as headcount_active,
           (select count(*) from hr.employee where status <> 'active')::int as headcount_inactive,
           (select count(*) from hr.document_exceptions)::int as missing_documents,
           (select count(*) from hr.attendance_exception where status in ('open', 'correction_proposed'))::int as open_attendance_exceptions,
           (select count(*) from hr.import_flag where status = 'open')::int as open_import_flags,
           (select count(*) from hr.attendance_import_batch where status = 'under_review')::int as batches_under_review,
           (select count(*) from hr.approval_request where status = 'pending')::int as pending_approvals,
           (select count(*) from hr.approval_request where status = 'pending'
              and requested_by <> hr.current_auth_user() and hr.has_role(required_role))::int as pending_my_decision`;
  const expiring = await ctx.tx<Summary["expiring"]>`
    select e.id as employee_id, e.employee_code, e.full_name, x.kind, x.end_date, (x.end_date - ${t}::date) as days_remaining
    from (select employee_id, 'probation_end' as kind, probation_end as end_date from hr.current_probation
          union all
          select employee_id, 'contract_end', contract_end from hr.current_contract where contract_end is not null) x
    join hr.employee e on e.id = x.employee_id and e.status = 'active'
    where x.end_date between ${t}::date and ${t}::date + ${lead}::int
    order by x.end_date`;
  return { ...s!, expiring };
}

export type Reference = {
  departments: { id: string; code: string; name: string }[];
  teams: { id: string; department_id: string; code: string; name: string }[];
  calendars: { id: string; code: string; name: string }[];
};

export async function reference(ctx: Ctx): Promise<Reference> {
  const [departments, teams, calendars] = await Promise.all([
    ctx.tx<Reference["departments"]>`select id, code, name from hr.department where is_active order by name`,
    ctx.tx<Reference["teams"]>`select id, department_id, code, name from hr.team where is_active order by name`,
    ctx.tx<Reference["calendars"]>`select id, code, name from hr.work_calendar order by name`,
  ]);
  return { departments, teams, calendars };
}

export async function me(ctx: Ctx) {
  const [row] = ctx.employeeId
    ? await ctx.tx<{ full_name: string }[]>`select full_name from hr.employee where id = ${ctx.employeeId}`
    : [];
  return { userId: ctx.principal.userId, email: ctx.principal.email, roles: [...ctx.roles].sort(),
           employeeId: ctx.employeeId, employeeName: row?.full_name ?? null };
}
