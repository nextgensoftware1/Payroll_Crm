"use client";
import { Eye, EyeOff } from "lucide-react";
import Link from "next/link";
import { useActionState, useState } from "react";
import { FormMessage, SubmitButton } from "@/components/forms";
import { signIn } from "@/app/auth/actions";

export function LoginForm({ next }: { next?: string }) {
  const [state, action] = useActionState(signIn, undefined);
  const [show, setShow] = useState(false);
  return (
    <form action={action} className="space-y-4" noValidate={false}>
      <input type="hidden" name="next" value={next ?? ""} />
      <div>
        <label className="label" htmlFor="email">Work email</label>
        <input className="field" id="email" name="email" type="email" autoComplete="username" placeholder="you@empirenetworks.com" required />
      </div>
      <div>
        <div className="flex items-center justify-between"><label className="label" htmlFor="password">Password</label>
          <Link href="/auth/forgot" className="mb-1 text-[12.5px] font-medium text-accent hover:underline">Forgot password?</Link></div>
        <div className="relative">
          <input className="field pr-10" id="password" name="password" type={show ? "text" : "password"} autoComplete="current-password" required />
          <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide password" : "Show password"} aria-pressed={show}
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-ink-3 hover:text-ink">{show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button>
        </div>
      </div>
      <FormMessage state={state} />
      <div className="[&>button]:w-full"><SubmitButton pendingText="Signing in…">Sign in</SubmitButton></div>
      <p className="text-center text-[12.5px] text-ink-3">HR and Admin accounts confirm with an authenticator app next.</p>
    </form>
  );
}
