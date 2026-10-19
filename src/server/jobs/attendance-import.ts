import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { type Tx, withRls } from "../db.ts";
import { configValue } from "../services/dashboard.ts";
import type { Storage } from "../storage.ts";
import { detectFlags, type Mapping } from "../zkteco/flags.ts";
import { okRows, parse } from "../zkteco/parser.ts";

/** Background import jobs. Run as DB role hr_worker (own grants + RLS
 *  policies), never as the owner, never with BYPASSRLS. Each job claims
 *  work with FOR UPDATE SKIP LOCKED, so overlapping cron runs are safe.
 *
 *    parseNextBatch   uploaded -> parsing -> under_review | parse_failed
 *    promoteDecided   accepted/rejected -> raw_punch (idempotent) + import_row_result */

export const PARSER_VERSION = "zkteco-ts/1.0";
const worker = <T>(fn: (tx: Tx) => Promise<T>) => withRls("worker", null, `job-${randomUUID()}`, fn);
const karachiNow = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 19); // PKT = UTC+5, no DST

type Claimed = { id: string; device_id: string; file_sha256: Buffer; claimed_start: string | null; claimed_end: string | null; object_path: string };

export async function parseNextBatch(storage: Storage): Promise<string | null> {
  const [batch] = await worker((tx) => tx<Claimed[]>`
    update hr.attendance_import_batch set status = 'parsing'
    where id = (select id from hr.attendance_import_batch where status = 'uploaded'
                order by uploaded_at for update skip locked limit 1)
    returning id, device_id, file_sha256, lower(claimed_period) as claimed_start, (upper(claimed_period) - 1) as claimed_end,
              (select object_path from hr.file_reference f where f.id = file_reference_id) as object_path`);
  if (!batch) return null;
  try {
    const data = await storage.read("attendance-imports", batch.object_path);
    if (!createHash("sha256").update(data).digest().equals(batch.file_sha256))
      throw new Error("stored file does not match the hash recorded at upload");
    await worker(async (tx) => {
      const [device] = await tx<{ datetime_format: string; status_label_map: Record<string, string> }[]>`
        select datetime_format, status_label_map from hr.device where id = ${batch.device_id}`;
      const pf = parse(data, { deviceFormat: device!.datetime_format, statusLabelMap: device!.status_label_map });
      const ids = new Map(pf.rows.map((r) => [r.rowNumber, randomUUID()]));
      const rows = pf.rows.map((r) => ({
        id: ids.get(r.rowNumber), batch_id: batch.id, row_number: r.rowNumber, raw_cells: r.cells, parse_status: r.status,
        parse_error: r.error, enrollment_no: r.enrollmentNo, name_seen: r.name, department_seen: r.department,
        device_local_ts: r.localTs, status_label_raw: r.statusLabel, direction_label: r.direction,
        verify_method: r.verify, location_code: r.location, workcode: r.workcode }));
      await tx`
        insert into hr.raw_import_row (id, batch_id, row_number, raw_cells, parse_status, parse_error, enrollment_no, name_seen,
                                       department_seen, device_local_ts, status_label_raw, direction_label, verify_method, location_code, workcode)
        select id, batch_id, row_number, raw_cells, parse_status, parse_error, enrollment_no, name_seen, department_seen,
               device_local_ts, status_label_raw, direction_label::hr.punch_direction, verify_method, location_code, workcode
        from jsonb_to_recordset(${tx.json(rows as never)}) as x(id uuid, batch_id uuid, row_number int, raw_cells jsonb,
             parse_status text, parse_error text, enrollment_no text, name_seen text, department_seen text, device_local_ts timestamp,
             status_label_raw text, direction_label text, verify_method text, location_code text, workcode text)`;

      const today = karachiNow().slice(0, 10);
      const nd = await configValue(tx, "attendance.near_duplicate_seconds", today);
      const mappings = (await tx<{ enrollment_no: string; employee_id: string; expected_name: string; vf: string | null; vt: string | null }[]>`
        select enrollment_no, employee_id, expected_name, lower(valid_during) as vf, upper(valid_during) as vt
        from hr.punch_mapping where device_id = ${batch.device_id} and status = 'approved'`)
        .map((m): Mapping => ({ enrollmentNo: m.enrollment_no, employeeId: m.employee_id, expectedName: m.expected_name, validFrom: m.vf, validTo: m.vt }));
      const flags = detectFlags(pf, {
        mappings, deviceFormat: device!.datetime_format, nearDuplicateSeconds: Number(nd?.value ?? 60),
        claimedPeriod: batch.claimed_start && batch.claimed_end ? [batch.claimed_start, batch.claimed_end] : null, nowLocal: karachiNow() });
      if (nd && nd.status !== "approved")
        for (const f of flags) if (f.kind === "near_duplicate") f.details.threshold_status = "proposed (not yet approved)";
      if (flags.length)
        await tx`
          insert into hr.import_flag (batch_id, raw_import_row_id, kind, details)
          select ${batch.id}::uuid, row_id, kind, details
          from jsonb_to_recordset(${tx.json(flags.map((f) => ({
            row_id: f.rowNumber === null ? null : ids.get(f.rowNumber), kind: f.kind, details: f.details })) as never)})
               as x(row_id uuid, kind text, details jsonb)`;
      await tx`
        update hr.attendance_import_batch
           set status = 'under_review', detected_source = ${pf.source}::hr.import_source,
               detected_encoding = ${pf.encoding + (pf.encodingCertain ? "" : " (uncertain)")}, parser_version = ${PARSER_VERSION},
               total_rows = ${pf.rows.length - 1}, parsed_rows = ${okRows(pf).length},
               error_rows = ${pf.rows.filter((r) => r.status === "error").length}, open_flags = ${flags.length}
         where id = ${batch.id}`;
    });
  } catch (e) {
    // record ANY failure on the batch (rows from the failed attempt were rolled back)
    const msg = `${e instanceof Error ? e.message : String(e)}`.slice(0, 1000);
    await worker((tx) => tx`update hr.attendance_import_batch set status = 'parse_failed', worker_error = ${msg}, parser_version = ${PARSER_VERSION}
                            where id = ${batch.id}`);
  }
  return batch.id;
}

export async function promoteDecided(): Promise<string | null> {
  return worker(async (tx) => {
    const [b] = await tx<{ id: string; status: string }[]>`
      select b.id, b.status::text as status from hr.attendance_import_batch b
      where b.status in ('accepted', 'rejected')
        and not exists (select 1 from hr.import_row_result x where x.batch_id = b.id)
      order by b.reviewed_at for update skip locked limit 1`;
    if (!b) return null;
    const rejected = b.status === "rejected";
    if (!rejected)
      await tx`
        insert into hr.raw_punch (device_id, enrollment_no, device_local_ts, status_label_raw, direction_label, punch_at, verify_method, first_seen_row_id)
        select bt.device_id, r.enrollment_no, r.device_local_ts, r.status_label_raw, coalesce(r.direction_label, 'unknown'),
               r.device_local_ts at time zone d.timezone, r.verify_method, r.id
        from hr.raw_import_row r join hr.attendance_import_batch bt on bt.id = r.batch_id join hr.device d on d.id = bt.device_id
        where r.batch_id = ${b.id} and r.parse_status = 'ok' order by r.row_number
        on conflict on constraint raw_punch_idempotency do nothing`;
    await tx`
      insert into hr.import_row_result (raw_import_row_id, batch_id, result, raw_punch_id)
      select r.id, r.batch_id,
             case when ${rejected}::boolean then 'batch_rejected' when r.parse_status = 'header' then 'header'
                  when r.parse_status = 'error' then 'parse_error' when p.first_seen_row_id = r.id then 'promoted'
                  else 'duplicate_existing' end,
             case when ${rejected}::boolean then null else p.id end
      from hr.raw_import_row r join hr.attendance_import_batch bt on bt.id = r.batch_id
      left join hr.raw_punch p on not ${rejected}::boolean and r.parse_status = 'ok' and p.device_id = bt.device_id
           and p.enrollment_no = r.enrollment_no and p.device_local_ts = r.device_local_ts and p.status_label_raw = r.status_label_raw
      where r.batch_id = ${b.id}`;
    await tx`
      update hr.attendance_import_batch set
        promoted_punches = (select count(*) from hr.import_row_result where batch_id = ${b.id} and result = 'promoted'),
        duplicate_punches = (select count(*) from hr.import_row_result where batch_id = ${b.id} and result = 'duplicate_existing')
      where id = ${b.id}`;
    return b.id;
  });
}

/** Single-admin mode: for each batch in review, create employees for new
 *  enrollment numbers and accept the batch. Off = batches wait for HR. */
export async function autoAcceptReviewed(): Promise<number> {
  return worker(async (tx) => {
    const [mode] = await tx<{ on: boolean }[]>`select hr.flag_enabled('single_admin_mode') as on`;
    if (!mode?.on) return 0;
    const batches = await tx<{ id: string }[]>`
      select id from hr.attendance_import_batch where status = 'under_review' order by uploaded_at for update skip locked`;
    for (const b of batches) {
      await tx`select hr.auto_setup_batch(${b.id})`;
      await tx`select hr.auto_accept_batch(${b.id})`;
    }
    return batches.length;
  });
}

/** Drain the queues within a time budget (serverless functions have a max duration). */
export async function runImportJobs(storage: Storage, budgetMs = 50_000) {
  const until = Date.now() + budgetMs;
  const done = { parsed: 0, autoAccepted: 0, promoted: 0 };
  while (Date.now() < until && (await parseNextBatch(storage))) done.parsed++;
  if (Date.now() < until) done.autoAccepted = await autoAcceptReviewed();
  while (Date.now() < until && (await promoteDecided())) done.promoted++;
  return done;
}
