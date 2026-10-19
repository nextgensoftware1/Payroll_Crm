"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { processImportsInBackground } from "@/server/kick";
import { act, userStorage } from "@/server/session";
import { createDevice as addDevice, decideBatch as decide, proposeMapping as propose,
         resolveFlags, uploadBatch as upload } from "@/server/services/attendance";

const field = (f: FormData, k: string) => String(f.get(k) ?? "");

/** Parsing never runs inside the user's request. after() starts it once the
 *  response is sent; the cron route (vercel.json) retries anything left over. */
const processInBackground = processImportsInBackground;

export async function uploadBatch(_: ActionState, form: FormData): Promise<ActionState> {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose the export file from the device." };
  const data = new Uint8Array(await file.arrayBuffer());
  let id = "";
  const r = await act(async (c) => {
    const chosen = field(form, "device_id");
    id = await upload(c, await userStorage(), {
      deviceId: chosen && chosen !== "new" ? chosen : null,
      newDevice: chosen === "new" ? { name: field(form, "new_device_name"), prefer: field(form, "prefer") === "day_first" ? "day_first" : "month_first" } : null,
      filename: file.name, data, claimedStart: field(form, "claimed_start"), claimedEnd: field(form, "claimed_end") });
  });
  if (r?.code === "duplicate_file") redirect(`/attendance/${String(r.extra?.existingBatchId)}?dup=1`);
  if (r?.error) return r;
  processInBackground();
  revalidatePath("/attendance");
  redirect(`/attendance/${id}`);
}

export async function createDevice(_: ActionState, form: FormData): Promise<ActionState> {
  const r = await act((c) => addDevice(c, Object.fromEntries(form) as never), "Device added.");
  revalidatePath("/attendance");
  return r;
}

export async function resolveKind(_: ActionState, form: FormData): Promise<ActionState> {
  const id = field(form, "batch_id");
  let n = 0;
  const r = await act(async (c) => { n = await resolveFlags(c, id, { kind: field(form, "kind"), status: field(form, "status") as "resolved", note: field(form, "note") }); });
  revalidatePath(`/attendance/${id}`);
  return r?.error ? r : { ok: true, message: `${n} flag${n === 1 ? "" : "s"} closed.` };
}

export async function decideBatch(_: ActionState, form: FormData): Promise<ActionState> {
  const id = field(form, "batch_id");
  const accept = field(form, "decision") === "accept";
  const r = await act((c) => decide(c, id, accept ? "accepted" : "rejected", field(form, "note")),
    accept ? "Accepted. Punches are being recorded." : "Rejected. Rows are kept as evidence; no punches recorded.");
  if (r?.ok) processInBackground();
  revalidatePath(`/attendance/${id}`);
  revalidatePath("/attendance");
  return r;
}

export async function proposeMapping(_: ActionState, form: FormData): Promise<ActionState> {
  const r = await act((c) => propose(c, {
    device_id: field(form, "device_id"), enrollment_no: field(form, "enrollment_no"), employee_id: field(form, "employee_id"),
    expected_name: field(form, "expected_name"), valid_from: field(form, "valid_from") }),
    "Sent to an Admin for approval. Later imports will use it once approved.");
  revalidatePath(`/attendance/${field(form, "batch_id")}`);
  return r;
}
