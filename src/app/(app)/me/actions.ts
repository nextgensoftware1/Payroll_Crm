"use server";
import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { act } from "@/server/session";
import { requestExcuse, requestLeave } from "@/server/services/requests";

const f = (form: FormData, k: string) => String(form.get(k) ?? "");

export async function leaveAction(_: ActionState, form: FormData): Promise<ActionState> {
  const r = await act((c) => requestLeave(c, { leave_type: f(form, "leave_type") as "ANNUAL", start_date: f(form, "start_date"),
    end_date: f(form, "end_date") || f(form, "start_date"), part_of_day: (f(form, "part_of_day") || "full") as "full", reason: f(form, "reason") }),
    "Leave requested. An Admin will review it; you'll get a notification.");
  revalidatePath("/me");
  return r;
}

export async function excuseAction(_: ActionState, form: FormData): Promise<ActionState> {
  const kind = f(form, "kind") as "late" | "missing_punch";
  const r = await act((c) => requestExcuse(c, { kind, business_date: f(form, "business_date"), reason: f(form, "reason"),
    punch_time: f(form, "punch_time") || null, punch_next_day: form.get("punch_next_day") === "on" }),
    kind === "late" ? "Sent. If an Admin accepts it, that day's late cut is removed." : "Sent. If an Admin accepts it, the time is added and the day is re-checked.");
  revalidatePath("/me");
  return r;
}
