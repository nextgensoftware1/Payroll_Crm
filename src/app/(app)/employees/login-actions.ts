"use server";
import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { SupabaseAuthAdmin } from "@/server/auth-admin";
import { act } from "@/server/session";
import { createLogin, resetPassword } from "@/server/services/logins";

const f = (form: FormData, k: string) => String(form.get(k) ?? "");

export async function createLoginAction(_: ActionState, form: FormData): Promise<ActionState> {
  const id = f(form, "employee_id");
  let msg = "";
  const r = await act(async (c) => {
    const x = await createLogin(c, new SupabaseAuthAdmin(), { employee_id: id, email: f(form, "email"), password: f(form, "password"), role: f(form, "role") as "employee" });
    msg = `Login created for ${x.name} (${x.email}${x.role !== "employee" ? `, ${x.role.toUpperCase()}` : ""}). Give them the email and temporary password privately; they'll choose their own password at first sign-in.`;
  });
  revalidatePath(`/employees/${id}`);
  return r?.error ? r : { ok: true, message: msg };
}

export async function resetPasswordAction(_: ActionState, form: FormData): Promise<ActionState> {
  const id = f(form, "employee_id");
  let msg = "";
  const r = await act(async (c) => {
    const x = await resetPassword(c, new SupabaseAuthAdmin(), { employee_id: id, password: f(form, "password") });
    msg = `Password reset for ${x.name}. Give them the new temporary password privately; they'll change it at next sign-in.`;
  });
  return r?.error ? r : { ok: true, message: msg };
}
