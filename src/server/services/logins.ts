import "server-only";
import { z } from "zod";
import type { AuthAdmin } from "../auth-admin.ts";
import { type Ctx, requireRole } from "../context.ts";
import { AppError, notFound } from "../errors.ts";

/** Login management from the employee page (Admin only).
 *  Order matters: the Supabase login is created first, then linked in our
 *  database; if linking fails, the new login is deleted again so no orphan
 *  account can sign in without a role. */

export const PasswordRule = z.string()
  .min(12, "Use at least 12 characters.")
  .refine((p) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p), "Mix upper- and lower-case letters and a number.");

export const CreateLoginInput = z.object({
  employee_id: z.guid(),
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid work email.")),
  password: PasswordRule,
  role: z.enum(["employee", "manager", "hr"]).default("employee"),
});

export async function createLogin(ctx: Ctx, auth: AuthAdmin, input: z.input<typeof CreateLoginInput>) {
  requireRole(ctx, "admin");
  const d = CreateLoginInput.parse(input);
  const [emp] = await ctx.tx<{ id: string; full_name: string; auth_user_id: string | null; status: string }[]>`
    select id, full_name, auth_user_id, status::text as status from hr.employee where id = ${d.employee_id}`;
  if (!emp) throw notFound("Employee");
  if (emp.status !== "active") throw new AppError(409, "not_active", "Only active employees can have a login.");
  if (emp.auth_user_id) throw new AppError(409, "has_login", `${emp.full_name} already has a login. Use Reset password instead.`);

  const user = await auth.createUser({ email: d.email, password: d.password });
  try {
    await ctx.tx.savepoint(async (sp) => {
      await sp`update hr.employee set auth_user_id = ${user.id}, work_email = coalesce(work_email, ${d.email}) where id = ${emp.id} and auth_user_id is null`;
      await sp`insert into hr.user_role (auth_user_id, role, granted_by, grant_reason)
               values (${user.id}, 'employee', hr.current_auth_user(), 'Login created in the app')`;
      if (d.role !== "employee")
        await sp`insert into hr.user_role (auth_user_id, role, granted_by, grant_reason)
                 values (${user.id}, ${d.role}::hr.app_role, hr.current_auth_user(), ${`Login created in the app as ${d.role}`})`;
      await sp`select hr.log_admin_action('employee', ${emp.id}, ${`Created login ${d.email} (${d.role}); must change password at first sign-in`})`;
    });
  } catch (e) {
    await auth.deleteUser(user.id).catch(() => {});   // no orphan login
    throw e;
  }
  return { name: emp.full_name, email: d.email, role: d.role, userId: user.id };
}

export async function resetPassword(ctx: Ctx, auth: AuthAdmin, input: { employee_id: string; password: string }) {
  requireRole(ctx, "admin");
  const password = PasswordRule.parse(input.password);
  const [emp] = await ctx.tx<{ id: string; full_name: string; auth_user_id: string | null }[]>`
    select id, full_name, auth_user_id from hr.employee where id = ${input.employee_id}`;
  if (!emp) throw notFound("Employee");
  if (!emp.auth_user_id) throw new AppError(409, "no_login", `${emp.full_name} has no login yet. Create one first.`);
  if (emp.auth_user_id === ctx.principal.userId) throw new AppError(409, "own_account", "Change your own password from the sign-in page instead.");
  await ctx.tx`select hr.log_admin_action('employee', ${emp.id}, 'Reset password; must change at next sign-in')`;
  await auth.setTemporaryPassword(emp.auth_user_id, password);
  return { name: emp.full_name };
}
