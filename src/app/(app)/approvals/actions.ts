"use server";
import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { act } from "@/server/session";
import { approveAllMine, decide as decideApproval } from "@/server/services/approvals";

export async function decide(_: ActionState, form: FormData): Promise<ActionState> {
  const decision = String(form.get("decision")) as "approved" | "rejected";
  const r = await act((c) => decideApproval(c, String(form.get("approval_id")), { decision, reason: String(form.get("reason") ?? "") }),
    decision === "approved" ? "Approved." : "Rejected.");
  revalidatePath("/approvals");
  revalidatePath("/", "layout");
  return r;
}

export async function approveAll(_: ActionState, form: FormData): Promise<ActionState> {
  let res = { approved: 0, failed: [] as { kind: string; message: string }[] };
  const r = await act(async (c) => { res = await approveAllMine(c, String(form.get("reason") ?? "")); });
  revalidatePath("/approvals");
  revalidatePath("/", "layout");
  if (r?.error) return r;
  return res.failed.length
    ? { error: `Approved ${res.approved}. ${res.failed.length} could not be approved: ${res.failed.slice(0, 3).map((f) => f.message).join("; ")}` }
    : { ok: true, message: `Approved ${res.approved} request${res.approved === 1 ? "" : "s"}.` };
}
