import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type Ctx, requireRole } from "../context.ts";
import { AppError } from "../errors.ts";
import { approveNowIfAllowed } from "./approvals.ts";

/** Set a monthly salary from the first day of a month. Earlier months keep
 *  the old salary (history is never overwritten). Approved immediately in
 *  single-admin mode; otherwise a second Admin approves it. */
export const SalaryInput = z.object({
  employee_id: z.guid(),
  salary_pkr: z.coerce.number().int("Whole rupees only.").min(0).max(10_000_000, "That salary looks too high."),
  from_month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Choose the month it applies from."),
});

export async function setSalary(ctx: Ctx, input: z.input<typeof SalaryInput>) {
  requireRole(ctx, "admin", "hr");
  const d = SalaryInput.parse(input);
  const from = `${d.from_month}-01`;
  const [emp] = await ctx.tx<{ id: string; full_name: string; joining_date: string }[]>`
    select id, full_name, joining_date from hr.employee where id = ${d.employee_id}`;
  if (!emp) throw new AppError(404, "not_found", "Employee not found.");
  const start = from < emp.joining_date ? emp.joining_date : from;

  // a newer proposal for the same person replaces any older one still waiting
  await ctx.tx`update hr.compensation_plan set status = 'retired' where employee_id = ${emp.id} and status = 'proposed'`;
  const planId = randomUUID(), approvalId = randomUUID();
  await ctx.tx`insert into hr.approval_request (id, kind, subject_table, subject_id, subject_employee_id, required_role, reason)
               values (${approvalId}, 'compensation_change', 'compensation_plan', ${planId}, ${emp.id}, 'admin',
                       ${`Monthly salary PKR ${d.salary_pkr.toLocaleString("en-PK")} from ${d.from_month}`})`;
  await ctx.tx`insert into hr.compensation_plan (id, employee_id, pay_basis, base_monthly_paisa, valid_during, approval_request_id)
               values (${planId}, ${emp.id}, 'fixed_monthly', ${d.salary_pkr * 100}, daterange(${start}::date, null), ${approvalId})`;
  return approveNowIfAllowed(ctx, approvalId, "salary set by HR/Admin");
}

export async function salaryHistory(ctx: Ctx, employeeId: string) {
  return ctx.tx<{ salary_paisa: string; from: string; to: string | null; status: string }[]>`
    select base_monthly_paisa as salary_paisa, lower(valid_during) as from, upper(valid_during) as to, status::text as status
    from hr.compensation_plan where employee_id = ${employeeId} and status in ('approved', 'proposed')
    order by lower(valid_during) desc`;
}
