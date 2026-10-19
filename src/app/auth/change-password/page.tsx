import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ActionForm } from "@/components/ActionForm";
import { AuthFrame } from "@/components/AuthFrame";
import { createClient } from "@/lib/supabase/server";
import { changeOwnPassword } from "../password-actions";

export const metadata: Metadata = { title: "Choose your password" };

export default async function ChangePassword() {
  const { data } = await (await createClient()).auth.getClaims();
  if (!data?.claims?.sub) redirect("/login");
  const email = typeof data.claims.email === "string" ? data.claims.email : "";
  return (
    <AuthFrame>
      <h1 className="text-[26px] font-semibold">Choose your own password</h1>
      <p className="mt-1 mb-6 text-ink-3">{email ? `Signed in as ${email}. ` : ""}Your account was set up with a temporary password. Pick a new one only you know.</p>
      <div className="panel p-6">
        <ActionForm action={changeOwnPassword} submit="Save and continue" pending="Saving…">
          <div><label className="label" htmlFor="password">New password</label>
            <input className="field" id="password" name="password" type="password" autoComplete="new-password" minLength={12} required /></div>
          <div><label className="label" htmlFor="confirm">Repeat it</label>
            <input className="field" id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={12} required /></div>
          <p className="text-[12.5px] text-ink-3">At least 12 characters, with upper- and lower-case letters and a number.</p>
        </ActionForm>
      </div>
    </AuthFrame>
  );
}
