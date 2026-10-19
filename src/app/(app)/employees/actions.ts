"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { act, userStorage } from "@/server/session";
import { review, uploadVersion } from "@/server/services/documents";
import { createEmployee as create, linkAccount as link, recordExit as exit } from "@/server/services/employees";

const field = (f: FormData, k: string) => String(f.get(k) ?? "");

export async function createEmployee(_: ActionState, form: FormData): Promise<ActionState> {
  let id = "";
  const r = await act(async (c) => { id = await create(c, Object.fromEntries(form) as never); });
  if (r?.error) return r.code === "already_exists" ? { error: "That employee code or email is already used." } : r;
  revalidatePath("/employees");
  redirect(`/employees/${id}`);
}

export async function uploadDocument(_: ActionState, form: FormData): Promise<ActionState> {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a PDF, JPG or PNG file." };
  const data = new Uint8Array(await file.arrayBuffer());
  const employeeId = field(form, "employee_id");
  const r = await act(async (c) => uploadVersion(c, await userStorage(),
    { employeeId, categoryId: field(form, "category_id"), filename: file.name, data }), "Uploaded. HR will review it.");
  revalidatePath(`/employees/${employeeId}`);
  revalidatePath("/me");
  return r;
}

export async function reviewDocument(_: ActionState, form: FormData): Promise<ActionState> {
  const decision = field(form, "decision") as "accepted" | "rejected";
  const r = await act((c) => review(c, field(form, "version_id"), { decision, reason: field(form, "reason"), expiry_date: field(form, "expiry_date") }),
    decision === "accepted" ? "Accepted." : "Rejected. The employee can upload a new version.");
  revalidatePath(`/employees/${field(form, "employee_id")}`);
  return r;
}

export async function recordExit(_: ActionState, form: FormData): Promise<ActionState> {
  const id = field(form, "employee_id");
  const r = await act((c) => exit(c, id, { status: field(form, "status") as "resigned", exit_date: field(form, "exit_date"), exit_reason: field(form, "exit_reason") }),
    "Exit recorded. Access is disabled; history is kept.");
  revalidatePath(`/employees/${id}`);
  return r;
}

export async function linkAccount(_: ActionState, form: FormData): Promise<ActionState> {
  const id = field(form, "employee_id");
  const r = await act((c) => link(c, id, field(form, "auth_user_id")), "Login linked. They can now sign in and see their own records.");
  revalidatePath(`/employees/${id}`);
  return r;
}
