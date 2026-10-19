import "server-only";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { config } from "../config.ts";
import { type Ctx, requireRole } from "../context.ts";
import { AppError, notFound } from "../errors.ts";
import type { Storage } from "../storage.ts";
import { detectDevice } from "../zkteco/detect.ts";
import { approveNowIfAllowed } from "./approvals.ts";
import { ParseError } from "../zkteco/parser.ts";

const ALLOWED = new Set([".csv", ".tsv", ".txt", ".xls", ".dat"]);
const staff = (ctx: Ctx) => requireRole(ctx, "admin", "hr");
const uuid = (v: string, what: string) => { if (!z.guid().safeParse(v).success) throw notFound(what); };

export type Device = { id: string; name: string; location_code: string; serial_number: string | null; timezone: string;
  datetime_format: string; status_label_map: Record<string, string>; is_active: boolean };

export async function listDevices(ctx: Ctx): Promise<Device[]> {
  staff(ctx);
  return ctx.tx<Device[]>`select id, name, location_code, serial_number, timezone, datetime_format, status_label_map, is_active
                          from hr.device order by name`;
}

export const DeviceInput = z.object({
  name: z.string().trim().min(2, "Name the device, for example Main entrance."),
  location_code: z.string().trim().min(1, "Enter the Location ID shown in exports.").max(20),
  datetime_format: z.string().trim().min(5, "Enter the date format the device writes."),
  in_label: z.string().trim().min(1), out_label: z.string().trim().min(1),
});

export async function createDevice(ctx: Ctx, input: z.input<typeof DeviceInput>) {
  staff(ctx);
  const d = DeviceInput.parse(input);
  const map = { [d.in_label]: "in", [d.out_label]: "out" };
  const [row] = await ctx.tx<{ id: string }[]>`
    insert into hr.device (name, location_code, datetime_format, status_label_map)
    values (${d.name}, ${d.location_code}, ${d.datetime_format}, ${ctx.tx.json(map)}) returning id`;
  return row!.id;
}

export type Batch = {
  id: string; device_id: string; device_name: string; original_filename: string; declared_extension: string;
  detected_source: string | null; detected_encoding: string | null; status: string; uploaded_at: string;
  uploaded_by_name: string | null; claimed_start: string | null; claimed_end: string | null; total_rows: number | null;
  parsed_rows: number | null; error_rows: number | null; promoted_punches: number | null; duplicate_punches: number | null;
  open_flags: number; worker_error: string | null; review_note: string | null;
};

const batchSelect = (ctx: Ctx) => ctx.tx`
  select b.id, b.device_id, dv.name as device_name, b.original_filename, b.declared_extension,
         b.detected_source::text as detected_source, b.detected_encoding, b.status::text as status,
         b.uploaded_at, up.full_name as uploaded_by_name,
         lower(b.claimed_period) as claimed_start, (upper(b.claimed_period) - 1) as claimed_end,
         b.total_rows, b.parsed_rows, b.error_rows, b.promoted_punches, b.duplicate_punches,
         (select count(*) from hr.import_flag f where f.batch_id = b.id and f.status = 'open')::int as open_flags,
         b.worker_error, b.review_note
  from hr.attendance_import_batch b
  join hr.device dv on dv.id = b.device_id
  left join hr.employee up on up.auth_user_id = b.uploaded_by`;

/** Stores the original file + hash and opens a review batch. Parsing is
 *  done by the background job, never in this request.
 *
 *  Pass `deviceId` for a known device, or `newDevice` to create one in the
 *  same transaction with settings READ FROM THE FILE (Location ID, In/Out
 *  labels, date format). A file whose Location ID or date format doesn't
 *  match the chosen device is refused: tying it to the wrong device would
 *  defeat duplicate protection. */
export async function uploadBatch(ctx: Ctx, storage: Storage, a: {
  deviceId?: string | null; newDevice?: { name: string; prefer?: "month_first" | "day_first" } | null;
  filename: string; data: Uint8Array; claimedStart?: string | null; claimedEnd?: string | null }) {
  staff(ctx);
  const name = path.basename(a.filename || "upload").slice(0, 200);
  const ext = path.extname(name).toLowerCase();
  if (!ALLOWED.has(ext)) throw new AppError(422, "unsupported_file", "Upload the device export as .csv, .txt or .xls.");
  if (!a.data.length) throw new AppError(422, "empty_file", "The file is empty.");
  if (a.data.length > config().MAX_UPLOAD_BYTES) throw new AppError(413, "file_too_large", "Files must be under 20 MB.");
  const cs = a.claimedStart || null, ce = a.claimedEnd || null;
  if (Boolean(cs) !== Boolean(ce)) throw new AppError(422, "period_incomplete", "Give both period dates, or leave both empty.");
  if (cs && ce && ce < cs) throw new AppError(422, "period_reversed", "The period end is before its start.");

  let found;
  try { found = detectDevice(a.data, a.newDevice?.prefer); } catch (e) {
    throw new AppError(422, "unreadable_file", e instanceof ParseError ? `This file can't be read: ${e.message}.` : "This file can't be read.");
  }
  const sha = createHash("sha256").update(a.data).digest();
  const [dup] = await ctx.tx<{ id: string }[]>`
    select id from hr.attendance_import_batch where file_sha256 = ${sha} and status not in ('rejected', 'parse_failed')`;
  if (dup) throw new AppError(409, "duplicate_file", "This exact file is already imported.", { existingBatchId: dup.id });

  let deviceId = a.deviceId ?? null;
  if (!deviceId) {
    const devName = a.newDevice?.name?.trim();
    if (!devName || devName.length < 2) throw new AppError(422, "device_name", "Name the device, for example Main entrance.");
    if (!found.datetimeFormat) throw new AppError(422, "unknown_format", "The date/time format in this file wasn't recognised. Send a sample row to IT.");
    if (!found.inLabel || !found.outLabel)
      throw new AppError(422, "unknown_labels", `Couldn't tell which Status values mean In and Out (found: ${found.labels.join(", ") || "none"}).`);
    if (found.locationCodes.length > 1)
      throw new AppError(422, "several_devices", `This file mixes Location IDs ${found.locationCodes.join(", ")}. Export each device separately.`);
    // Same machine already registered under this name? Reuse it instead of failing.
    const [same] = await ctx.tx<{ id: string }[]>`
      select id from hr.device where location_code = ${found.locationCode ?? "unknown"} and lower(name) = lower(${devName})`;
    const [dev] = same ? [same] : await ctx.tx<{ id: string }[]>`
      insert into hr.device (name, location_code, datetime_format, status_label_map)
      values (${devName}, ${found.locationCode ?? "unknown"}, ${found.datetimeFormat},
              ${ctx.tx.json({ [found.inLabel]: "in", [found.outLabel]: "out" })}) returning id`;
    deviceId = dev!.id;
  } else {
    const [dev] = await ctx.tx<{ name: string; location_code: string; datetime_format: string }[]>`
      select name, location_code, datetime_format from hr.device where id = ${deviceId}`;
    if (!dev) throw new AppError(422, "unknown_device", "Choose a device.");
    if (found.locationCodes.length && !found.locationCodes.every((c) => c === dev.location_code))
      throw new AppError(422, "device_mismatch", `This file is from Location ID ${found.locationCodes.join(", ")}, but "${dev.name}" is Location ${dev.location_code}. Choose the right device, or add a new one.`);
    if (found.datetimeFormat && !found.ambiguous && !sameFormatFamily(dev.datetime_format, found.datetimeFormat))
      throw new AppError(422, "format_mismatch", `This file's dates look like ${found.datetimeFormat}, but "${dev.name}" is set to ${dev.datetime_format}. Check the export settings on the device.`);
  }

  const batchId = randomUUID(), fileId = randomUUID();
  const objectPath = `${batchId}/${sha.toString("hex")}${ext}`;
  await ctx.tx`insert into hr.file_reference (id, bucket, object_path, sha256, size_bytes, mime_type, original_filename, uploaded_by)
               values (${fileId}, 'attendance-imports', ${objectPath}, ${sha}, ${a.data.length}, 'application/octet-stream', ${name}, hr.current_auth_user())`;
  await ctx.tx`insert into hr.attendance_import_batch (id, device_id, declared_extension, file_reference_id, file_sha256,
                                                       original_filename, claimed_period, uploaded_by)
               values (${batchId}, ${deviceId}, ${ext}, ${fileId}, ${sha}, ${name},
                       case when ${cs}::date is null then null else daterange(${cs}::date, ${ce}::date, '[]') end,
                       hr.current_auth_user())`;
  await storage.upload("attendance-imports", objectPath, a.data, "application/octet-stream");
  return batchId;
}

/** Same day/month order and clock style? (exact token spelling may differ) */
function sameFormatFamily(deviceFormat: string, detected: string): boolean {
  const family = (f: string) => [f.startsWith("D") ? "D" : f.startsWith("Y") ? "Y" : "M", /AM/.test(f) ? "12h" : "24h"].join("");
  return family(deviceFormat) === family(detected);
}

export async function listBatches(ctx: Ctx, status?: string | null): Promise<Batch[]> {
  staff(ctx);
  return ctx.tx<Batch[]>`${batchSelect(ctx)}
    where (${status ?? null}::text is null or b.status::text = ${status ?? null}::text)
    order by b.uploaded_at desc limit 100`;
}

export type PersonSummary = { enrollment_no: string; name_seen: string | null; rows: number; first_at: string; last_at: string;
  employee_id: string | null; employee_code: string | null; employee_name: string | null; open_flags: number };

export async function getBatch(ctx: Ctx, id: string) {
  staff(ctx);
  uuid(id, "Import batch");
  const [b] = await ctx.tx<Batch[]>`${batchSelect(ctx)} where b.id = ${id}`;
  if (!b) throw notFound("Import batch");
  const flagCounts = await ctx.tx<{ kind: string; status: string; count: number }[]>`
    select kind, status, count(*)::int as count from hr.import_flag where batch_id = ${id} group by kind, status order by kind, status`;
  const people = await ctx.tx<PersonSummary[]>`
    with per as (
      select r.enrollment_no, mode() within group (order by r.name_seen) as name_seen, count(*)::int as rows,
             min(r.device_local_ts) as first_at, max(r.device_local_ts) as last_at
      from hr.raw_import_row r where r.batch_id = ${id} and r.parse_status = 'ok' group by r.enrollment_no)
    select per.*, pm.employee_id, e.employee_code, e.full_name as employee_name,
           (select count(*)::int from hr.import_flag f join hr.raw_import_row rr on rr.id = f.raw_import_row_id
            where f.batch_id = ${id} and f.status = 'open' and rr.enrollment_no = per.enrollment_no) as open_flags
    from per join hr.attendance_import_batch b on b.id = ${id}
    left join hr.punch_mapping pm on pm.device_id = b.device_id and pm.enrollment_no = per.enrollment_no
         and pm.status = 'approved' and pm.valid_during @> per.last_at::date
    left join hr.employee e on e.id = pm.employee_id
    order by length(per.enrollment_no), per.enrollment_no`;
  return { ...b, flag_counts: flagCounts, people };
}

export type Flag = { id: string; kind: string; status: "open" | "resolved" | "accepted_as_is"; row_number: number | null;
  details: Record<string, unknown>; resolution_note: string | null; resolved_at: string | null };

export async function listFlags(ctx: Ctx, batchId: string, f: { status?: string | null; kind?: string | null } = {}): Promise<Flag[]> {
  staff(ctx);
  uuid(batchId, "Import batch");
  return ctx.tx<Flag[]>`
    select f.id, f.kind, f.status, r.row_number, f.details, f.resolution_note, f.resolved_at
    from hr.import_flag f left join hr.raw_import_row r on r.id = f.raw_import_row_id
    where f.batch_id = ${batchId}
      and (${f.status ?? null}::text is null or f.status = ${f.status ?? null}::text)
      and (${f.kind ?? null}::text is null or f.kind = ${f.kind ?? null}::text)
    order by f.status = 'open' desc, f.kind, r.row_number nulls first`;
}

export const ResolveInput = z.object({
  kind: z.string().min(1),
  status: z.enum(["resolved", "accepted_as_is"]),
  note: z.string().trim().min(3, "Write what you checked; the note is kept on the record."),
});

/** Closes every open flag of ONE kind with one recorded note. */
export async function resolveFlags(ctx: Ctx, batchId: string, input: z.input<typeof ResolveInput>) {
  staff(ctx);
  const d = ResolveInput.parse(input);
  const res = await ctx.tx`
    update hr.import_flag set status = ${d.status}, resolution_note = ${d.note}, resolved_by = hr.current_auth_user(), resolved_at = now()
    where batch_id = ${batchId} and status = 'open' and kind = ${d.kind}
      and exists (select 1 from hr.attendance_import_batch where id = ${batchId} and status = 'under_review')`;
  return res.count;
}

/** Accept only with zero open flags. Promotion to raw_punch is done by the
 *  background job afterwards (insert-only, idempotent). */
export async function decideBatch(ctx: Ctx, batchId: string, decision: "accepted" | "rejected", note: string) {
  staff(ctx);
  if (note.trim().length < 3) throw new AppError(422, "note_required", "Add a review note.");
  const [row] = await ctx.tx`
    update hr.attendance_import_batch
       set status = ${decision}::hr.batch_status, reviewed_by = hr.current_auth_user(), reviewed_at = now(), review_note = ${note.trim()}
     where id = ${batchId} and status = 'under_review'
       and (${decision}::text = 'rejected' or not exists (
             select 1 from hr.import_flag f where f.batch_id = ${batchId} and f.status = 'open'))
    returning id`;
  if (!row) throw new AppError(409, "cannot_decide",
    decision === "accepted" ? "Resolve every open flag first, and check the batch is in review." : "Only a batch in review can be rejected.");
}

export type Punch = { row_number: number; local_ts: string; status_label: string; direction: string; flags: string[] };

export async function punches(ctx: Ctx, batchId: string, enrollmentNo: string) {
  staff(ctx);
  uuid(batchId, "Import batch");
  return ctx.tx<Punch[]>`
    select r.row_number, r.device_local_ts as local_ts, r.status_label_raw as status_label,
           coalesce(r.direction_label::text, 'unknown') as direction,
           coalesce(array_agg(f.kind) filter (where f.kind is not null), '{}') as flags
    from hr.raw_import_row r left join hr.import_flag f on f.raw_import_row_id = r.id
    where r.batch_id = ${batchId} and r.parse_status = 'ok' and r.enrollment_no = ${enrollmentNo}
    group by r.id order by r.device_local_ts`;
}

export const MappingInput = z.object({
  device_id: z.guid(), enrollment_no: z.string().trim().min(1).max(20),
  employee_id: z.guid("Choose the employee."), expected_name: z.string().trim().min(1),
  valid_from: z.iso.date("Choose the date this enrollment number started."),
});

/** Creates a PROPOSED mapping + approval request. It affects attendance only
 *  after a DIFFERENT Admin approves it (enforced by the database). */
export async function proposeMapping(ctx: Ctx, input: z.input<typeof MappingInput>) {
  staff(ctx);
  const d = MappingInput.parse(input);
  const mappingId = randomUUID(), approvalId = randomUUID();
  await ctx.tx`insert into hr.approval_request (id, kind, subject_table, subject_id, subject_employee_id, required_role, reason)
               values (${approvalId}, 'punch_mapping', 'punch_mapping', ${mappingId}, ${d.employee_id}, 'admin',
                       ${`Enrollment ${d.enrollment_no} seen in a device import`})`;
  await ctx.tx`insert into hr.punch_mapping (id, device_id, enrollment_no, employee_id, expected_name, valid_during, approval_request_id)
               values (${mappingId}, ${d.device_id}, ${d.enrollment_no}, ${d.employee_id}, ${d.expected_name},
                       daterange(${d.valid_from}::date, null), ${approvalId})`;
  const approved = await approveNowIfAllowed(ctx, approvalId, "enrollment link");
  return { mappingId, approvalId, approved };
}

export async function listMappings(ctx: Ctx) {
  staff(ctx);
  return ctx.tx<{ id: string; enrollment_no: string; employee_name: string; expected_name: string; valid_from: string | null; status: string }[]>`
    select pm.id, pm.enrollment_no, e.full_name as employee_name, pm.expected_name,
           lower(pm.valid_during) as valid_from, pm.status::text as status
    from hr.punch_mapping pm join hr.employee e on e.id = pm.employee_id
    order by length(pm.enrollment_no), pm.enrollment_no`;
}
