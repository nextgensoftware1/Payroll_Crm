"use client";
import { useActionState } from "react";
import { FormMessage, SubmitButton } from "@/components/forms";
import type { ActionState } from "@/lib/action-state";

/** Generic form bound to a Server Action, with inline result messages. */
export function ActionForm({ action, children, submit, pending, variant, className, encType }: {
  action: (s: ActionState, f: FormData) => Promise<ActionState>;
  children: React.ReactNode; submit: string; pending?: string;
  variant?: "primary" | "quiet" | "danger"; className?: string; encType?: string;
}) {
  const [state, formAction] = useActionState(action, undefined);
  return (
    <form action={formAction} className={className ?? "space-y-3"} encType={encType}>
      {children}
      <FormMessage state={state} />
      <SubmitButton variant={variant} pendingText={pending}>{submit}</SubmitButton>
    </form>
  );
}
