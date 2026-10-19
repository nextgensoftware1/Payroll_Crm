import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/ActionForm";
import { AuthFrame } from "@/components/AuthFrame";
import { requestReset } from "../password-actions";

export const metadata: Metadata = { title: "Reset password" };

export default async function Forgot({ searchParams }: { searchParams: Promise<{ expired?: string }> }) {
  const { expired } = await searchParams;
  return (
    <AuthFrame>
      <h1 className="text-[26px] font-semibold">Reset your password</h1>
      <p className="mt-1 mb-6 text-ink-3">We&apos;ll email you a link to choose a new one.</p>
      {expired ? <p role="alert" className="mb-4 rounded-lg bg-warn-soft px-3 py-2 text-[13.5px] text-warn">That link has expired. Request a new one.</p> : null}
      <div className="panel p-6">
        <ActionForm action={requestReset} submit="Send reset link" pending="Sending…">
          <div><label className="label" htmlFor="email">Work email</label>
            <input className="field" id="email" name="email" type="email" autoComplete="username" required /></div>
        </ActionForm>
      </div>
      <Link href="/login" className="mt-4 inline-block text-[13.5px] font-medium text-accent hover:underline">← Back to sign in</Link>
    </AuthFrame>
  );
}
