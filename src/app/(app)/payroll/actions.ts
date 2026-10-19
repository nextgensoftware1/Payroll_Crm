"use server";
import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { act } from "@/server/session";
import { approveAndLock, backToDraft, calculate, reopen, sendForReview } from "@/server/services/payroll";

const f = (form: FormData, k: string) => String(form.get(k) ?? "");
const done = () => { revalidatePath("/payroll"); revalidatePath("/me"); };

export async function calc(_: ActionState, form: FormData): Promise<ActionState> {
  let msg = "";
  const r = await act(async (c) => {
    const x = await calculate(c, f(form, "month"));
    msg = `Calculated ${x.lines} payslip${x.lines === 1 ? "" : "s"}.${x.missingSalary.length ? ` ${x.missingSalary.length} people have no salary and are not included.` : ""}`;
  });
  done();
  return r?.error ? r : { ok: true, message: msg };
}
export async function review(_: ActionState, form: FormData): Promise<ActionState> {
  const r = await act((c) => sendForReview(c, f(form, "run_id")), "Sent for approval."); done(); return r;
}
export async function draft(_: ActionState, form: FormData): Promise<ActionState> {
  const r = await act((c) => backToDraft(c, f(form, "run_id")), "Back to draft. You can recalculate."); done(); return r;
}
export async function lock(_: ActionState, form: FormData): Promise<ActionState> {
  const r = await act((c) => approveAndLock(c, f(form, "run_id"), f(form, "note")), "Approved and locked. Payslips are ready."); done(); return r;
}
export async function reopenRun(_: ActionState, form: FormData): Promise<ActionState> {
  let opened = false;
  const r = await act(async (c) => { opened = (await reopen(c, f(form, "run_id"), f(form, "reason"))).reopened; });
  done();
  return r?.error ? r : { ok: true, message: opened ? "Reopened as a new draft. The locked version is kept. Recalculate when ready." : "Reopen request sent to a second Admin." };
}
