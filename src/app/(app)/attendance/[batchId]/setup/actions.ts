"use server";
import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { act } from "@/server/session";
import { setupFromBatch } from "@/server/services/setup";

export async function runSetup(_: ActionState, form: FormData): Promise<ActionState> {
  const batchId = String(form.get("batch_id"));
  const nos = form.getAll("enrollment_no").map(String);
  const val = (k: string) => String(form.get(k) ?? "").trim();
  const rows = nos.map((no) => ({
    enrollment_no: no, include: form.get(`include_${no}`) === "on",
    employee_code: val(`code_${no}`), full_name: val(`name_${no}`),
    shift_hour: val(`shift_${no}`) === "" ? null : Number(val(`shift_${no}`)),
    salary_pkr: val(`salary_${no}`) === "" ? null : Number(val(`salary_${no}`).replace(/[, ]/g, "")),
  }));
  let res = { employees: 0, salaries: 0, mappings: 0, skipped: 0 };
  const r = await act(async (c) => {
    res = await setupFromBatch(c, batchId, { joining_date: val("joining_date"), department_id: val("department_id") || null, rows });
  });
  if (r?.error) return r;
  revalidatePath(`/attendance/${batchId}`);
  revalidatePath("/approvals");
  return { ok: true, message: `Done: ${res.employees} employees created${res.skipped ? ` (${res.skipped} already existed)` : ""}, ${res.salaries} salaries and ${res.mappings} enrollment links sent to Approvals. A different Admin must approve them.` };
}
