"use server";
import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { act } from "@/server/session";
import { changeConfig, submitConfig } from "@/server/services/approvals";

export async function submit(_: ActionState, form: FormData): Promise<ActionState> {
  const r = await act((c) => submitConfig(c, String(form.get("id"))), "Sent. A different Admin approves it in Approvals.");
  revalidatePath("/settings");
  return r;
}

export async function change(_: ActionState, form: FormData): Promise<ActionState> {
  let now = false;
  const r = await act(async (c) => { now = await changeConfig(c, String(form.get("key")), Number(form.get("value")), String(form.get("from") ?? "")); });
  revalidatePath("/settings"); revalidatePath("/reports"); revalidatePath("/dashboard");
  return r?.error ? r : { ok: true, message: now ? "Saved. Applies from that date." : "Sent for approval." };
}
