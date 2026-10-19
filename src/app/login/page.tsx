import type { Metadata } from "next";
import { AuthFrame } from "@/components/AuthFrame";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; reset?: string }> }) {
  const { next, reset } = await searchParams;
  return (
    <AuthFrame>
      <h1 className="text-[26px] font-semibold">Welcome back</h1>
      <p className="mt-1 mb-6 text-ink-3">Sign in with your named company account.</p>
      {reset ? <p role="status" className="mb-4 rounded-lg bg-ok-soft px-3 py-2 text-[13.5px] text-ok">Password updated. Sign in with your new password.</p> : null}
      <div className="panel p-6"><LoginForm next={next} /></div>
      <p className="mt-4 text-[12.5px] text-ink-3">Accounts are created by HR for named staff only. Shared logins are not allowed.</p>
    </AuthFrame>
  );
}
