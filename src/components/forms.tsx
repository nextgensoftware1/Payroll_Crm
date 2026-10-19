"use client";
import { useFormStatus } from "react-dom";
import type { ActionState } from "@/lib/action-state";

// Full class names written out: Tailwind only generates classes it can find literally in the source.
const VARIANT = { primary: "btn-primary", quiet: "btn-quiet", danger: "btn-danger" } as const;

export function SubmitButton({ children, pendingText, variant = "primary" }:
  { children: React.ReactNode; pendingText?: string; variant?: "primary" | "quiet" | "danger" }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-busy={pending} className={VARIANT[variant]}>
      {pending ? pendingText ?? "Saving…" : children}
    </button>
  );
}

export function FormMessage({ state }: { state: ActionState }) {
  if (!state) return null;
  if (state.error)
    return <p role="alert" className="rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">{state.error}</p>;
  if (state.ok && state.message)
    return <p role="status" className="rounded-md bg-ok-soft px-3 py-2 text-sm text-ok">{state.message}</p>;
  return null;
}
