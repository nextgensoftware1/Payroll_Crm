import "server-only";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { config } from "../config.ts";
import { type Ctx, requireRole, today } from "../context.ts";
import { AppError, notFound } from "../errors.ts";
import type { Storage } from "../storage.ts";
import { getEmployee } from "./employees.ts";

const MIME: Record<string, string> = { ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };
const MAX_DOC_BYTES = 10 * 1024 * 1024;

export type DocVersion = { id: string; version_no: number; original_filename: string; size_bytes: number;
  uploaded_at: string; review_decision: string | null; review_reason: string | null };
export type ChecklistItem = { category_id: string; category_code: string; category_name: string; sensitivity: string;
  has_expiry: boolean; required: boolean; document_id: string | null; status: string; expiry_date: string | null; versions: DocVersion[] };

/** Managers never see documents; employees see only their own. RLS
 *  enforces the same thing underneath this check. */
function assertMayAccess(ctx: Ctx, employeeId: string) {
  if (!ctx.isStaff && ctx.employeeId !== employeeId) throw notFound("Employee");
}

export async function checklist(ctx: Ctx, employeeId: string): Promise<ChecklistItem[]> {
  assertMayAccess(ctx, employeeId);
  await getEmployee(ctx, employeeId);
  return ctx.tx<ChecklistItem[]>`
    with emp as (select id, employment_category from hr.employee where id = ${employeeId})
    select dc.id as category_id, dc.code as category_code, dc.name as category_name, dc.sensitivity, dc.has_expiry,
           coalesce(r.is_required, false) as required, ed.id as document_id,
           coalesce(ed.status::text, 'missing') as status, ed.expiry_date,
           coalesce((select jsonb_agg(jsonb_build_object(
                       'id', v.id, 'version_no', v.version_no, 'original_filename', f.original_filename,
                       'size_bytes', f.size_bytes, 'uploaded_at', v.uploaded_at,
                       'review_decision', rv.decision, 'review_reason', rv.reason) order by v.version_no desc)
                     from hr.document_version v join hr.file_reference f on f.id = v.file_reference_id
                     left join hr.document_review rv on rv.document_version_id = v.id
                     where v.document_id = ed.id), '[]'::jsonb) as versions
    from emp cross join hr.document_category dc
    left join hr.document_requirement r on r.category_id = dc.id and r.employment_category = emp.employment_category
         and r.status = 'approved' and r.valid_during @> ${today()}::date
    left join hr.employee_document ed on ed.employee_id = emp.id and ed.category_id = dc.id
    where r.id is not null or ed.id is not null
    order by coalesce(r.is_required, false) desc, dc.name`;
}

function magicMatches(data: Uint8Array, ext: string): boolean {
  const b = (...xs: number[]) => xs.every((x, i) => data[i] === x);
  if (ext === ".pdf") return b(0x25, 0x50, 0x44, 0x46, 0x2d);
  if (ext === ".png") return b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  return b(0xff, 0xd8, 0xff);
}

export async function uploadVersion(ctx: Ctx, storage: Storage, a: { employeeId: string; categoryId: string; filename: string; data: Uint8Array }) {
  assertMayAccess(ctx, a.employeeId);
  const name = path.basename(a.filename || "upload").slice(0, 200);
  const ext = path.extname(name).toLowerCase();
  if (!MIME[ext]) throw new AppError(422, "unsupported_file", "Use a PDF, JPG or PNG file.");
  if (!a.data.length) throw new AppError(422, "empty_file", "The file is empty.");
  if (a.data.length > MAX_DOC_BYTES) throw new AppError(413, "file_too_large", "Documents must be under 10 MB.");
  if (!magicMatches(a.data, ext)) throw new AppError(422, "content_mismatch", "The file contents do not match its extension.");

  let docId: string | null;
  if (ctx.isStaff) {
    const [existing] = await ctx.tx<{ id: string }[]>`select id from hr.employee_document where employee_id = ${a.employeeId} and category_id = ${a.categoryId}`;
    docId = existing?.id ?? (await ctx.tx<{ id: string }[]>`
      insert into hr.employee_document (employee_id, category_id, status, requested_at)
      values (${a.employeeId}, ${a.categoryId}, 'requested', now()) returning id`)[0]!.id;
  } else {
    // employees may only upload into a document HR has requested
    const [row] = await ctx.tx<{ id: string }[]>`select id from hr.employee_document where employee_id = ${a.employeeId} and category_id = ${a.categoryId}`;
    docId = row?.id ?? null;
    if (!docId) throw new AppError(409, "not_requested", "HR has not requested this document yet.");
  }
  const sha = createHash("sha256").update(a.data).digest();
  const fileId = randomUUID();
  const objectPath = `${a.employeeId}/${docId}/${fileId}-${sha.toString("hex").slice(0, 12)}${ext}`;
  await ctx.tx`insert into hr.file_reference (id, bucket, object_path, sha256, size_bytes, mime_type, original_filename, owner_employee_id, uploaded_by)
               values (${fileId}, 'employee-documents', ${objectPath}, ${sha}, ${a.data.length}, ${MIME[ext]!}, ${name}, ${a.employeeId}, hr.current_auth_user())`;
  const [v] = await ctx.tx<{ id: string; version_no: number }[]>`
    insert into hr.document_version (document_id, version_no, file_reference_id)
    select ${docId}, coalesce(max(version_no), 0) + 1, ${fileId} from hr.document_version where document_id = ${docId}
    returning id, version_no`;
  // DB rows first, then the object: if the upload fails the transaction rolls back
  await storage.upload("employee-documents", objectPath, a.data, MIME[ext]!);
  return v!;
}

export const ReviewInput = z.object({
  decision: z.enum(["accepted", "rejected"]),
  reason: z.string().trim().min(3, "Give a short reason; it is kept on the record."),
  expiry_date: z.string().trim().transform((v) => v || null).pipe(z.iso.date().nullable()).nullish(),
});

export async function review(ctx: Ctx, versionId: string, input: z.input<typeof ReviewInput>) {
  requireRole(ctx, "admin", "hr");
  const d = ReviewInput.parse(input);
  if (d.decision === "accepted" && d.expiry_date && d.expiry_date < today())
    throw new AppError(422, "expired", "That expiry date has already passed.");
  await ctx.tx`insert into hr.document_review (document_version_id, decision, reason, expiry_date_confirmed)
               values (${versionId}, ${d.decision}, ${d.reason}, ${d.expiry_date ?? null})`;
}

/** Access-checked (RLS), audited, short-lived. */
export async function prepareDownload(ctx: Ctx, storage: Storage, versionId: string) {
  if (!z.guid().safeParse(versionId).success) throw notFound("Document");
  const [f] = await ctx.tx<{ bucket: string; object_path: string; original_filename: string; mime_type: string }[]>`
    select f.bucket, f.object_path, f.original_filename, f.mime_type
    from hr.document_version v join hr.employee_document ed on ed.id = v.document_id
    join hr.file_reference f on f.id = v.file_reference_id where v.id = ${versionId}`;
  if (!f) throw notFound("Document");
  await ctx.tx`select hr.log_access('document_version', ${versionId}, 'READ', 'download')`;
  const url = await storage.signedUrl(f.bucket, f.object_path, config().SIGNED_URL_TTL_SECONDS);
  return { url, file: f, read: () => storage.read(f.bucket, f.object_path) };
}
