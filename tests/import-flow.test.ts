/** End to end with the real August file: upload -> background parse ->
 *  review flags -> mapping approval (segregation of duties) -> accept ->
 *  promote -> re-import adds zero punches. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { promoteDecided, parseNextBatch, runImportJobs } from "../src/server/jobs/attendance-import.ts";
import { decide, listApprovals } from "../src/server/services/approvals.ts";
import { decideBatch, getBatch, listFlags, listMappings, proposeMapping, resolveFlags, uploadBatch } from "../src/server/services/attendance.ts";
import { okRows, parse } from "../src/server/zkteco/parser.ts";
import { DEVICE, EMP, rejects, SAMPLE, setup } from "./harness.ts";

let h: Awaited<ReturnType<typeof setup>>;
let batch = "";
before(async () => { h = await setup(); });
after(async () => { await h.teardown(); });
const upload = (data: Uint8Array, filename: string) => h.as("hr", (c) => uploadBatch(c, h.storage,
  { deviceId: DEVICE, filename, data, claimedStart: "2026-08-01", claimedEnd: "2026-08-31" }));
const punchCount = async () => Number((await h.owner`select count(*) from hr.raw_punch`)[0]!.count);

test("upload opens a review batch; nothing parsed in the request", async () => {
  batch = await upload(SAMPLE, "AUGUST_ATTANADANCE.xls");
  const b = await h.as("hr", (c) => getBatch(c, batch));
  assert.equal(b.status, "uploaded");
  assert.equal(b.total_rows, null);
});

test("the same file twice is refused", async () => {
  const e = await rejects(upload(SAMPLE, "copy.xls"), 409);
  assert.equal(e.extra.existingBatchId, batch);
});

test("employees cannot upload", async () => {
  await rejects(h.as("e1", (c) => uploadBatch(c, h.storage, { deviceId: DEVICE, filename: "x.csv", data: SAMPLE }), "aal1"), 403);
});

test("background job parses and flags", async () => {
  assert.equal(await parseNextBatch(h.storage), batch);
  assert.equal(await parseNextBatch(h.storage), null); // queue empty
  const b = await h.as("hr", (c) => getBatch(c, batch));
  assert.equal(b.status, "under_review");
  assert.equal(b.detected_source, "xls_biff");
  assert.deepEqual([b.total_rows, b.parsed_rows, b.error_rows], [476, 476, 0]);
  const counts = Object.fromEntries(b.flag_counts.map((f) => [`${f.kind}/${f.status}`, f.count]));
  assert.equal(counts["unknown_enrollment/open"], 15);
  assert.equal(counts["near_duplicate/open"], 11);
  assert.equal(b.people.length, 15);
  assert.equal(b.people[0]!.enrollment_no, "1");
  assert.equal(Number((await h.owner`select count(*) from hr.raw_import_row where batch_id = ${batch}`)[0]!.count), 477);
  assert.equal(await punchCount(), 0);
});

test("cannot accept while flags are open", async () => {
  await rejects(h.as("hr", (c) => decideBatch(c, batch, "accepted", "looks fine")), 409, "Resolve every open flag");
});

test("a mapping needs a DIFFERENT admin", async () => {
  const { approvalId } = await h.as("hr", (c) => proposeMapping(c, {
    device_id: DEVICE, enrollment_no: "1", employee_id: EMP.e1, expected_name: "Moon", valid_from: "2026-01-01" }));
  await rejects(h.as("hr", (c) => decide(c, approvalId, { decision: "approved", reason: "mine" })), 409, "segregation of duties");
  const queue = await h.as("admin", (c) => listApprovals(c, { mine: true }));
  const item = queue.find((a) => a.id === approvalId)!;
  assert.ok(item.can_decide);
  assert.equal(item.subject?.enrollment_no, "1");
  await h.as("admin", (c) => decide(c, approvalId, { decision: "approved", reason: "Matches enrolment sheet" }));
  const maps = await h.as("hr", (c) => listMappings(c));
  assert.equal(maps[0]!.status, "approved");
});

test("resolve flags with a note, accept, promote: 476 punches stored in UTC", async () => {
  for (const kind of ["unknown_enrollment", "near_duplicate", "encoding_uncertain", "direction_conflict"])
    await h.as("hr", (c) => resolveFlags(c, batch, { kind, status: "accepted_as_is", note: `Reviewed ${kind} on screen` }));
  assert.equal((await h.as("hr", (c) => listFlags(c, batch, { status: "open" }))).length, 0);
  await h.as("hr", (c) => decideBatch(c, batch, "accepted", "August export checked"));
  assert.equal(await promoteDecided(), batch);
  const b = await h.as("hr", (c) => getBatch(c, batch));
  assert.deepEqual([b.status, b.promoted_punches, b.duplicate_punches], ["accepted", 476, 0]);
  assert.equal(await punchCount(), 476);
  // 8/1/2026 3:06:51 AM Karachi = 2026-07-31 22:06:51 UTC
  const [p] = await h.owner`select to_char(punch_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') as t from hr.raw_punch
                            where enrollment_no = '1' order by device_local_ts limit 1`;
  assert.equal(p!.t, "2026-07-31 22:06:51");
});

test("re-import as CSV (different bytes, same punches) adds zero", async () => {
  const pf = parse(SAMPLE, { deviceFormat: "M/D/YYYY h:mm:ss AM", statusLabelMap: {} });
  const text = pf.rows.map((r) => r.cells.map((c) => (/[",\n]/.test(c) ? `"${c.replaceAll('"', '""')}"` : c)).join(",")).join("\n");
  const b2 = await upload(new TextEncoder().encode(text), "AUGUST_resaved.csv");
  await runImportJobs(h.storage);
  const flags = await h.as("hr", (c) => listFlags(c, b2, { kind: "unknown_enrollment" }));
  assert.equal(flags.length, 14); // enrollment 1 is now mapped
  assert.ok(flags.every((f) => f.details.enrollment_no !== "1"));
  for (const kind of ["unknown_enrollment", "near_duplicate", "direction_conflict"])
    await h.as("hr", (c) => resolveFlags(c, b2, { kind, status: "accepted_as_is", note: "Known from August batch" }));
  await h.as("hr", (c) => decideBatch(c, b2, "accepted", "Duplicate check"));
  await runImportJobs(h.storage);
  const b = await h.as("hr", (c) => getBatch(c, b2));
  assert.equal(b.detected_source, "csv");
  assert.deepEqual([b.promoted_punches, b.duplicate_punches], [0, 476]);
  assert.equal(await punchCount(), 476);
  assert.equal(okRows(pf).length, 476);
});

test("a rejected batch keeps its rows as evidence but records no punches", async () => {
  const csv = "No.,Name,Date/Time,Status\n99,Test,8/5/2026 9:00:00 AM,C/In\n";
  const b3 = await upload(new TextEncoder().encode(csv), "wrong.csv");
  await runImportJobs(h.storage);
  await h.as("hr", (c) => decideBatch(c, b3, "rejected", "Wrong device"));
  await runImportJobs(h.storage);
  const res = await h.owner`select result from hr.import_row_result where batch_id = ${b3}`;
  assert.ok(res.length === 2 && res.every((r) => r.result === "batch_rejected"));
  assert.equal(await punchCount(), 476);
});

test("an unreadable file is refused at upload with a reason, nothing stored", async () => {
  const before = Number((await h.owner`select count(*) from hr.attendance_import_batch`)[0]!.count);
  await rejects(upload(new TextEncoder().encode("garbage,header\n1,2\n"), "bad.csv"), 422, "can't be read");
  assert.equal(Number((await h.owner`select count(*) from hr.attendance_import_batch`)[0]!.count), before);
});

test("raw punches cannot be altered, even by an admin", async () => {
  await rejects(h.as("admin", (c) => c.tx`update hr.raw_punch set device_local_ts = device_local_ts + interval '1 hour'`), 403);
  await rejects(h.as("admin", (c) => c.tx`delete from hr.raw_punch`), 403);
});
