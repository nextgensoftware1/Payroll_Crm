import type { Metadata } from "next";
import { ActionForm } from "@/components/ActionForm";
import { AuthFrame } from "@/components/AuthFrame";
import { updatePassword } from "../password-actions";

export const metadata: Metadata = { title: "Choose a new password" };

export default function UpdatePassword() {
  return (
    <AuthFrame>
      <h1 className="text-[26px] font-semibold">Choose a new password</h1>
      <p className="mt-1 mb-6 text-ink-3">At least 12 characters, with upper- and lower-case letters and a number.</p>
      <div className="panel p-6">
        <ActionForm action={updatePassword} submit="Save new password" pending="Saving…">
          <div><label className="label" htmlFor="password">New password</label>
            <input className="field" id="password" name="password" type="password" autoComplete="new-password" minLength={12} required /></div>
          <div><label className="label" htmlFor="confirm">Repeat it</label>
            <input className="field" id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={12} required /></div>
        </ActionForm>
      </div>
    </AuthFrame>
  );
}
