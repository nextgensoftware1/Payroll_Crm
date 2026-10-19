import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type Ctx, requireRole, today } from "../context.ts";
import { AppError, notFound } from "../errors.ts";

/** Employee register. Every query runs under the caller's RLS context:
 *  asking for someone you may not see returns nothing, and callers answer
 *  "not found" (existence is never confirmed). */

export const EmploymentCategory = z.enum(["fixed_monthly", "fixed_plus_incentive", "commission_only",
  "probationary_trainee", "contractor", "consultant"]);

const optStr = z.string().trim().transform((v) => v || null).nullish();
const optUuid = z.string().trim().transform((v) => v || null).pipe(z.guid().nullable()).nullish();
const optDate = z.string().trim().transform((v) => v || null).pipe(z.iso.date().nullable()).nullish();

export const NewEmployee = z.object({
  employee_code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,20}$/, "Codes use letters, numbers and dashes, like EN-0048."),
  full_name: z.string().trim().min(2, "Enter the full name.").max(120),
  preferred_name: optStr, work_email: z.string().trim().transform((v) => v || null).pipe(z.email("Enter a valid email.").nullable()).nullish(),
  phone: optStr, location: optStr,
  employment_category: EmploymentCategory,
  joining_date: z.iso.date("Choose the joining date."),
  department_id: z.guid("Choose a department."),
  team_id: optUuid, job_title: z.string().trim().min(2, "Enter the job title.").max(120),
  manager_employee_id: optUuid, calendar_id: optUuid, probation_end: optDate, contract_end: optDate,
}).refine((d) => !d.probation_end || d.probation_end >= d.joining_date, { message: "Probation end is before the joining date." })
  .refine((d) => !d.contract_end || d.contract_end >= d.joining_date, { message: "Contract end is before the joining date." });

export const ExitInput = z.object({
  status: z.enum(["terminated", "resigned"]),
  exit_date: z.iso.date("Choose the last day."),
  exit_reason: z.string().trim().min(5, "Describe the exit in a few words."),
});

export type EmployeeRow = {
  id: string; employee_code: string; full_name: string; preferred_name: string | null; work_email: string | null;
  phone: string | null; location: string | null; status: "active" | "terminated" | "resigned";
  employment_category: z.infer<typeof EmploymentCategory>; joining_date: string; exit_date: string | null;
  exit_reason: string | null; has_login: boolean; job_title: string | null; department_id: string | null;
  department_name: string | null; team_id: string | null; team_name: string | null; manager_name: string | null;
  documents: { required: number; complete: number } | null;
};

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

async function selectEmployees(ctx: Ctx, where: { id?: string; q?: string | null; status?: string | null;
  departmentId?: string | null; limit?: number; offset?: number }) {
  const { tx } = ctx;
  const t = today();
  const q = where.q ? like(where.q) : null;
  const rows = await tx<(Omit<EmployeeRow, "documents"> & { required_count: number; complete_count: number; total: number })[]>`
    select e.id, e.employee_code, e.full_name, e.preferred_name, e.work_email, e.phone, e.location,
           e.status::text as status, e.employment_category::text as employment_category,
           e.joining_date, e.exit_date, e.exit_reason, (e.auth_user_id is not null) as has_login,
           a.job_title, a.department_id, d.name as department_name, a.team_id, tm.name as team_name,
           m.full_name as manager_name, docs.required_count, docs.complete_count,
           count(*) over ()::int as total
    from hr.employee e
    left join lateral (
      select ea.job_title, ea.department_id, ea.team_id from hr.employee_assignment ea
      where ea.employee_id = e.id and ea.valid_during @> ${t}::date
      order by lower(ea.valid_during) desc limit 1) a on true
    left join hr.department d on d.id = a.department_id
    left join hr.team tm on tm.id = a.team_id
    left join lateral (
      select me.full_name from hr.manager_assignment ma join hr.employee me on me.id = ma.manager_employee_id
      where ma.employee_id = e.id and ma.valid_during @> ${t}::date limit 1) m on true
    left join lateral (
      select count(*)::int as required_count,
             count(*) filter (where ed.status in ('accepted', 'not_applicable')
                                and (ed.expiry_date is null or ed.expiry_date >= ${t}::date))::int as complete_count
      from hr.document_requirement r
      left join hr.employee_document ed on ed.employee_id = e.id and ed.category_id = r.category_id
      where r.employment_category = e.employment_category and r.status = 'approved'
        and r.is_required and r.valid_during @> ${t}::date) docs on true
    where (${where.id ?? null}::uuid is null or e.id = ${where.id ?? null}::uuid)
      and (${q}::text is null or e.full_name ilike ${q}::text or e.employee_code ilike ${q}::text or e.work_email ilike ${q}::text)
      and (${where.status ?? null}::text is null or e.status::text = ${where.status ?? null}::text)
      and (${where.departmentId ?? null}::uuid is null or a.department_id = ${where.departmentId ?? null}::uuid)
    order by e.employee_code
    limit ${where.limit ?? 50} offset ${where.offset ?? 0}`;
  return rows.map(({ required_count, complete_count, total, ...r }) => ({
    row: { ...r, documents: ctx.isStaff ? { required: required_count, complete: complete_count } : null } as EmployeeRow,
    total,
  }));
}

export async function listEmployees(ctx: Ctx, f: { q?: string | null; status?: string | null; departmentId?: string | null; page?: number; pageSize?: number }) {
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 200);
  const page = Math.max(f.page ?? 1, 1);
  const res = await selectEmployees(ctx, { ...f, limit: pageSize, offset: (page - 1) * pageSize });
  return { items: res.map((r) => r.row), total: res[0]?.total ?? 0, page, pageSize };
}

export type Lifecycle = { start: string; end: string | null; revision_no: number; action: string };

export async function getEmployee(ctx: Ctx, id: string) {
  if (!z.guid().safeParse(id).success) throw notFound("Employee");
  const [hit] = await selectEmployees(ctx, { id, limit: 1 });
  if (!hit) throw notFound("Employee");
  const [probation] = await ctx.tx<Lifecycle[]>`
    select probation_start as start, probation_end as "end", revision_no, action::text as action
    from hr.current_probation where employee_id = ${id} order by probation_end desc limit 1`;
  const [contract] = await ctx.tx<Lifecycle[]>`
    select contract_start as start, contract_end as "end", revision_no, action::text as action
    from hr.current_contract where employee_id = ${id} order by contract_start desc limit 1`;
  return { ...hit.row, probation: probation ?? null, contract: contract ?? null };
}

export type TimelineEvent = { occurred_at: string; kind: string; title: string; detail: Record<string, unknown> | null };

export async function timeline(ctx: Ctx, id: string): Promise<TimelineEvent[]> {
  await getEmployee(ctx, id); // 404 if not visible
  return ctx.tx<TimelineEvent[]>`
    select * from (
      select e.created_at as occurred_at, 'joined' as kind, 'Joined as ' || replace(e.employment_category::text, '_', ' ') as title,
             jsonb_build_object('joining_date', e.joining_date) as detail
      from hr.employee e where e.id = ${id}
      union all
      select ea.created_at, 'position', ea.job_title || coalesce(' in ' || d.name, ''),
             jsonb_build_object('from', lower(ea.valid_during), 'to', upper(ea.valid_during))
      from hr.employee_assignment ea left join hr.department d on d.id = ea.department_id where ea.employee_id = ${id}
      union all
      select ma.created_at, 'manager', 'Reports to ' || me.full_name, null
      from hr.manager_assignment ma join hr.employee me on me.id = ma.manager_employee_id where ma.employee_id = ${id}
      union all
      select p.created_at, 'probation', 'Probation ' || p.action::text || ' (revision ' || p.revision_no || '), ends ' || to_char(p.probation_end, 'DD Mon YYYY'),
             jsonb_build_object('reason', p.reason, 'approved', p.revision_no = 1 or hr.is_approved(p.approval_request_id))
      from hr.probation_period p where p.employee_id = ${id}
      union all
      select c.created_at, 'contract', 'Contract ' || c.action::text || ' (revision ' || c.revision_no || ')',
             jsonb_build_object('reason', c.reason, 'end', c.contract_end)
      from hr.employment_contract c where c.employee_id = ${id}
      union all
      select v.uploaded_at, 'document', dc.name || ' version ' || v.version_no || ' uploaded', null
      from hr.document_version v join hr.employee_document ed on ed.id = v.document_id
      join hr.document_category dc on dc.id = ed.category_id where ed.employee_id = ${id}
      union all
      select rv.reviewed_at, 'document', dc.name || ' ' || rv.decision, jsonb_build_object('reason', rv.reason)
      from hr.document_review rv join hr.document_version v on v.id = rv.document_version_id
      join hr.employee_document ed on ed.id = v.document_id
      join hr.document_category dc on dc.id = ed.category_id where ed.employee_id = ${id}
      union all
      select r.requested_at, 'approval', initcap(replace(r.kind::text, '_', ' ')) || ': ' || r.status::text, jsonb_build_object('reason', r.reason)
      from hr.approval_request r where r.subject_employee_id = ${id}
      union all
      select e.updated_at, 'exit', initcap(e.status::text) || ', last day ' || to_char(e.exit_date, 'DD Mon YYYY'), jsonb_build_object('reason', e.exit_reason)
      from hr.employee e where e.id = ${id} and e.status <> 'active'
    ) t order by occurred_at desc limit 200`;
}

/** One transaction: employee + first placement + calendar + manager +
 *  probation/contract revision 1 + 'requested' rows for every document the
 *  approved checklist requires for this employment type. */
export async function createEmployee(ctx: Ctx, input: z.input<typeof NewEmployee>) {
  requireRole(ctx, "admin", "hr");
  const d = NewEmployee.parse(input);
  const { tx } = ctx;
  const [created] = await tx<{ id: string }[]>`
    insert into hr.employee (employee_code, full_name, preferred_name, work_email, phone, location, employment_category, joining_date)
    values (${d.employee_code}, ${d.full_name}, ${d.preferred_name ?? null}, ${d.work_email ?? null}, ${d.phone ?? null},
            ${d.location ?? null}, ${d.employment_category}::hr.employment_category, ${d.joining_date})
    returning id`;
  const id = created!.id;
  await tx`insert into hr.employee_assignment (employee_id, department_id, team_id, job_title, valid_during)
           values (${id}, ${d.department_id}, ${d.team_id ?? null}, ${d.job_title}, daterange(${d.joining_date}::date, null))`;
  if (d.calendar_id)
    await tx`insert into hr.employee_calendar_assignment (employee_id, calendar_id, valid_during)
             values (${id}, ${d.calendar_id}, daterange(${d.joining_date}::date, null))`;
  if (d.manager_employee_id)
    await tx`insert into hr.manager_assignment (employee_id, manager_employee_id, valid_during)
             values (${id}, ${d.manager_employee_id}, daterange(${d.joining_date}::date, null))`;
  if (d.probation_end)
    await tx`insert into hr.probation_period (series_id, revision_no, employee_id, probation_start, probation_end, action, reason, effective_date)
             values (${randomUUID()}, 1, ${id}, ${d.joining_date}, ${d.probation_end}, 'initial', 'Set at onboarding', ${d.joining_date})`;
  await tx`insert into hr.employment_contract (series_id, revision_no, employee_id, contract_start, contract_end, action, reason, effective_date)
           values (${randomUUID()}, 1, ${id}, ${d.joining_date}, ${d.contract_end ?? null}, 'initial', 'Set at onboarding', ${d.joining_date})`;
  await tx`insert into hr.employee_document (employee_id, category_id, status, requested_at)
           select ${id}, r.category_id, 'requested', now() from hr.document_requirement r
           where r.employment_category = ${d.employment_category}::hr.employment_category
             and r.status = 'approved' and r.is_required and r.valid_during @> ${d.joining_date}::date`;
  return id;
}

/** Admin only. Disables access and revokes roles; history is untouched. */
export async function recordExit(ctx: Ctx, id: string, input: z.input<typeof ExitInput>) {
  requireRole(ctx, "admin");
  const d = ExitInput.parse(input);
  const [row] = await ctx.tx<{ auth_user_id: string | null }[]>`
    update hr.employee set status = ${d.status}::hr.employee_status, exit_date = ${d.exit_date}, exit_reason = ${d.exit_reason}
    where id = ${id} and status = 'active' returning auth_user_id`;
  if (!row) throw new AppError(409, "not_active", "Employee not found or already exited.");
  if (row.auth_user_id)
    await ctx.tx`update hr.user_role set revoked_at = now(), revoked_by = hr.current_auth_user()
                 where auth_user_id = ${row.auth_user_id} and revoked_at is null`;
}

export async function linkAccount(ctx: Ctx, id: string, authUserId: string) {
  requireRole(ctx, "admin");
  const uid = z.guid("Paste the user's ID from Supabase Authentication > Users.").parse(authUserId.trim());
  const res = await ctx.tx`update hr.employee set auth_user_id = ${uid} where id = ${id} and auth_user_id is null and status = 'active'`;
  if (res.count !== 1) throw new AppError(409, "cannot_link", "Employee not found, not active, or already linked.");
  await ctx.tx`insert into hr.user_role (auth_user_id, role, granted_by, grant_reason)
               select ${uid}, 'employee', hr.current_auth_user(), 'Linked to employee record'
               where not exists (select 1 from hr.user_role where auth_user_id = ${uid} and role = 'employee' and revoked_at is null)`;
}
