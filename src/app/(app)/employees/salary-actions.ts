"use server";
import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { act } from "@/server/session";
import { setSalary } from "@/server/services/salary";

export async function saveSalary(_: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get("employee_id"));
  let now = false;
  const r = await act(async (c) => { now = await setSalary(c, {
    employee_id: id, salary_pkr: String(form.get("salary_pkr") ?? "").replace(/[, ]/g, ""), from_month: String(form.get("from_month") ?? "") }); });
  revalidatePath(`/employees/${id}`); revalidatePath("/dashboard"); revalidatePath("/reports");
  return r?.error ? r : { ok: true, message: now ? "Saved. Reports use it straight away." : "Sent for approval. A second Admin must approve it." };
}
