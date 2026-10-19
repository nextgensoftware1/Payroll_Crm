"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ActionState } from "@/lib/action-state";
import { createClient } from "@/lib/supabase/server";
import { SupabaseAuthAdmin } from "@/server/auth-admin";

export async function requestReset(_: ActionState, form: FormData): Promise<ActionState> {
  const email = z.email("Enter your work email.").safeParse(String(form.get("email") ?? "").trim());
  if (!email.success) return { error: email.error.issues[0]?.message };
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  await (await createClient()).auth.resetPasswordForEmail(email.data, { redirectTo: `${origin}/auth/callback?next=/auth/update-password` });
  // Same answer whether or not the account exists, so emails can't be probed.
  return { ok: true, message: "If that email has an account, a reset link is on its way. It expires in one hour." };
}

const Strong = z.string().min(12, "Use at least 12 characters.")
  .refine((p) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p), "Mix upper- and lower-case letters and a number.");

export async function updatePassword(_: ActionState, form: FormData): Promise<ActionState> {
  const pw = String(form.get("password") ?? ""), again = String(form.get("confirm") ?? "");
  const parsed = Strong.safeParse(pw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  if (pw !== again) return { error: "The two passwords don't match." };
  const sb = await createClient();
  const { data: who } = await sb.auth.getClaims();
  const { error } = await sb.auth.updateUser({ password: pw });
  if (error) return { error: "That link has expired or the password was rejected. Request a new link." };
  if (who?.claims?.sub) await new SupabaseAuthAdmin().clearMustChange(who.claims.sub).catch(() => {});
  await sb.auth.signOut();
  redirect("/login?reset=1");
}

/** First sign-in with a temporary password: choose your own, then continue. */
export async function changeOwnPassword(_: ActionState, form: FormData): Promise<ActionState> {
  const pw = String(form.get("password") ?? ""), again = String(form.get("confirm") ?? "");
  const parsed = Strong.safeParse(pw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  if (pw !== again) return { error: "The two passwords don't match." };
  const sb = await createClient();
  const { data: who } = await sb.auth.getClaims();
  if (!who?.claims?.sub) redirect("/login");
  const { error } = await sb.auth.updateUser({ password: pw });
  if (error) return { error: /same|different/i.test(error.message) ? "Choose a password different from the temporary one." : `The password was rejected: ${error.message}` };
  await new SupabaseAuthAdmin().clearMustChange(who.claims.sub);
  await sb.auth.refreshSession(); // new token without the must-change flag
  redirect("/");
}
