"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ActionState } from "@/lib/action-state";
import { createClient } from "@/lib/supabase/server";

const SignIn = z.object({
  email: z.email("Enter your company email."),
  password: z.string().min(1, "Enter your password."),
  next: z.string().regex(/^\/[A-Za-z0-9/_-]*$/).optional().catch(undefined),
});

export async function signIn(_: ActionState, form: FormData): Promise<ActionState> {
  const parsed = SignIn.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email: parsed.data.email, password: parsed.data.password });
  if (error) return { error: "That email and password don't match a company account." };
  redirect(parsed.data.next && parsed.data.next !== "/login" ? parsed.data.next : "/");
}

export async function signOut() {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();
  if (error) {
    console.error("[empire-hr] sign-out failed:", error.message);
  }
  redirect("/login");
}
