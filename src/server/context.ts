import "server-only";
import { randomUUID } from "node:crypto";
import { type Claims, type Tx, withRls } from "./db.ts";
import { AppError } from "./errors.ts";

export type Role = "admin" | "hr" | "manager" | "employee" | "auditor";
export type Principal = { userId: string; email: string | null; aal: string; mustChangePassword?: boolean };

export type Ctx = {
  tx: Tx;
  principal: Principal;
  roles: ReadonlySet<Role>;
  employeeId: string | null;
  isStaff: boolean;
  isAdmin: boolean;
  requestId: string;
};

/** Run fn as this person, inside one RLS-scoped transaction.
 *  Authorisation happens twice on purpose: coarse role checks here give
 *  clear errors; Postgres RLS + grants + triggers are the real enforcement. */
export async function runAs<T>(principal: Principal, fn: (ctx: Ctx) => Promise<T>,
                               opts: { roles?: Role[]; requestId?: string } = {}): Promise<T> {
  const claims: Claims = { sub: principal.userId, role: "authenticated", aal: principal.aal, email: principal.email };
  const requestId = opts.requestId ?? randomUUID();
  return withRls("app", claims, requestId, async (tx) => {
    const [row] = await tx<{ roles: Role[]; employee_id: string | null }[]>`
      select coalesce(array_agg(distinct ur.role::text), '{}') as roles, hr.current_employee_id() as employee_id
      from hr.user_role ur
      where ur.auth_user_id = hr.current_auth_user() and ur.revoked_at is null
        and ur.valid_during @> (now() at time zone 'Asia/Karachi')::date`;
    const roles = new Set(row!.roles);
    if (!roles.size) throw new AppError(403, "no_access", "Your account has no role yet. Ask an Admin to grant access.");
    const isStaff = roles.has("admin") || roles.has("hr");
    if (opts.roles && !opts.roles.some((r) => roles.has(r)))
      throw new AppError(403, "not_permitted", "Your role does not allow this action.");
    return fn({ tx, principal, roles, employeeId: row!.employee_id, isStaff, isAdmin: roles.has("admin"), requestId });
  });
}

export function requireRole(ctx: Ctx, ...roles: Role[]): void {
  if (!roles.some((r) => ctx.roles.has(r))) throw new AppError(403, "not_permitted", "Your role does not allow this action.");
}

export const today = (): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date()); // YYYY-MM-DD
