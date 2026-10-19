import "server-only";
import { notFound, redirect, unstable_rethrow } from "next/navigation";
import { cache } from "react";
import type { ActionState } from "@/lib/action-state";
import { createClient } from "@/lib/supabase/server";
import { config } from "./config.ts";
import { type Ctx, type Principal, type Role, runAs } from "./context.ts";
import { toAppError } from "./errors.ts";
import { LocalStorage, type Storage, SupabaseStorage } from "./storage.ts";

/** The ONLY place that touches Next.js + Supabase Auth. Everything under
 *  src/server/services is framework-free and tested with node:test. */

/** getClaims() verifies the JWT signature (JWKS). Cached per request. */
export const getPrincipal = cache(async (): Promise<Principal> => {
  const { data } = await (await createClient()).auth.getClaims();
  const c = data?.claims;
  if (!c?.sub) redirect("/login");
  const meta = (c as { app_metadata?: { must_change_password?: boolean } }).app_metadata;
  return { userId: c.sub, email: typeof c.email === "string" ? c.email : null, aal: typeof c.aal === "string" ? c.aal : "aal1",
           mustChangePassword: meta?.must_change_password === true };
});

/** Storage as the signed-in person: Supabase storage.objects RLS applies. */
export async function userStorage(): Promise<Storage> {
  const c = config();
  return c.STORAGE_BACKEND === "local" ? new LocalStorage(c.LOCAL_STORAGE_DIR) : new SupabaseStorage(await createClient());
}

/** For pages: run fn as the signed-in person in one RLS transaction.
 *  404s render the not-found page; missing MFA goes to /mfa. */
export async function withSession<T>(fn: (ctx: Ctx) => Promise<T>, opts?: { roles?: Role[] }): Promise<T> {
  const principal = await getPrincipal();
  if (principal.mustChangePassword) redirect("/auth/change-password");
  try {
    return await runAs(principal, fn, opts);
  } catch (e) {
    unstable_rethrow(e);
    const err = toAppError(e);
    if (err.code === "mfa_required") redirect("/mfa");
    if (err.status === 404) notFound();
    if (err.status >= 500) console.error("[empire-hr] page failed:", err.cause ?? e);
    throw err;
  }
}

/** For Server Actions: same, but errors become a form message instead of a crash. */
export async function act(fn: (ctx: Ctx) => Promise<unknown>, success?: string): Promise<ActionState> {
  const principal = await getPrincipal();
  if (principal.mustChangePassword) return { error: "Choose your own password first." };
  try {
    await runAs(principal, fn);
    return { ok: true, message: success };
  } catch (e) {
    unstable_rethrow(e);
    const err = toAppError(e);
    if (err.code === "mfa_required") redirect("/mfa");
    if (err.status >= 500) console.error("[empire-hr] action failed:", err.cause ?? e);
    return { error: err.message, code: err.code, extra: err.extra };
  }
}
