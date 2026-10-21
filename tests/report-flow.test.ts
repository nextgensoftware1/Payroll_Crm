/** Full flow on the real August file: set up people from the import ->
 *  a different Admin approves everything -> accept -> monthly report. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { runImportJobs } from "../src/server/jobs/attendance-import.ts";
import { approveAllMine } from "../src/server/services/approvals.ts";
import { decideBatch, resolveFlags, uploadBatch } from "../src/server/services/attendance.ts";
import { monthReport } from "../src/server/services/reports.ts";
import { setupCandidates, setupFromBatch } from "../src/server/services/setup.ts";
import { rejects, SAMPLE, setup } from "./harness.ts";

let h: Awaited<ReturnType<typeof setup>>;
let batch = "";
before(async () => { h = await setup(); });
after(async () => { await h.teardown(); });

test("set up all 15 people from the import with suggested shifts", async () => {
  batch = await h.as("hr", (c) => uploadBatch(c, h.storage, { newDevice: { name: "Main entrance" }, filename: "AUGUST.xls", data: SAMPLE }));
  await runImportJobs(h.storage);
  const cand = await h.as("hr", (c) => setupCandidates(c, batch));
  assert.equal(cand.people.length, 15);
  const moon = cand.people.find((p) => p.enrollment_no === "1")!;
  assert.deepEqual([moon.name_seen, moon.suggested_hour, moon.suggested_salary, moon.salary_source], ["Moon", 17, 52000, "sample"]);
  assert.equal(cand.people.find((p) => p.enrollment_no === "42")!.suggested_hour, null); // Huzaifa: 1 day only
  const done = await h.as("hr", (c) => setupFromBatch(c, batch, {
    joining_date: "2026-08-01", department_id: null,
    rows: cand.people.map((p) => ({ enrollment_no: p.enrollment_no, include: true, employee_code: `EM-${p.enrollment_no.padStart(4, "0")}`,
      full_name: p.name_seen ?? `No. ${p.enrollment_no}`, shift_hour: p.suggested_hour, salary_pkr: p.suggested_salary })),
  }));
  assert.deepEqual(done, { employees: 15, salaries: 15, mappings: 15, skipped: 0 });
});

test("HR cannot approve their own setup; a second Admin approves all 30 in one go", async () => {
  const mine = await h.as("hr", (c) => approveAllMine(c, "self"));
  assert.equal(mine.approved, 0);
  const r = await h.as("admin", (c) => approveAllMine(c, "Checked against August sheet"));
  assert.equal(r.approved, 30);
  assert.deepEqual(r.failed, []);
});

test("report before acceptance: everyone looks absent because no punches are official yet", async () => {
  const rep = await h.as("admin", (c) => monthReport(c, { month: "2026-08" }));
  const moon = rep.people.find((p) => p.full_name === "Moon")!;
  assert.equal(moon.result.totals.absent, 21);
});

test("accept the batch, then the August report is computed from real punches", async () => {
  for (const kind of ["unknown_enrollment", "near_duplicate", "encoding_uncertain", "direction_conflict"])
    await h.as("hr", (c) => resolveFlags(c, batch, { kind, status: "accepted_as_is", note: "Reviewed" }));
  await h.as("hr", (c) => decideBatch(c, batch, "accepted", "August checked"));
  await runImportJobs(h.storage);

  const t0 = performance.now();
  const rep = await h.as("admin", (c) => monthReport(c, { month: "2026-08" }));
  const ms = performance.now() - t0;
  assert.equal(rep.people.length, 18); // 15 set up + 3 fixture employees
  assert.ok(ms < 1500, `report took ${ms.toFixed(0)} ms`);

  const moon = rep.people.find((p) => p.full_name === "Moon")!;
  const t = moon.result.totals;
  assert.equal(moon.shift!.name, "5 PM to 2 AM");
  assert.equal(moon.salary_status, "approved");
  assert.equal(t.scheduled, 21);
  assert.equal(t.present + t.late + t.absent + t.incomplete + t.leave + t.holiday, 21);
  assert.equal(t.dailyRatePaisa, 236364);   // 52,000 / 22
  assert.equal(t.latePenaltyPaisa, 9455);   // 4%
  assert.equal(t.totalDeductionPaisa, t.late * 9455 + t.absent * 236364);
  assert.equal(t.netPaisa, 5_200_000 - t.totalDeductionPaisa);

  // cross-check one real night by hand: Moon, Monday 3 Aug
  const d = moon.result.days.find((x) => x.date === "2026-08-03")!;
  assert.ok(d.firstIn && d.firstIn.startsWith("2026-08-03T1"), `first in ${d.firstIn}`);
  const late = (Date.parse(`${d.firstIn}Z`) - Date.parse("2026-08-03T17:00:00Z")) / 1000 > 600;
  assert.equal(d.status, d.punches < 2 ? "incomplete" : late ? "late" : "present");

  const hz = rep.people.find((p) => p.full_name === "Huzaifa")!;
  assert.equal(hz.shift, null); // no shift: attendance can't be judged, nothing deducted
  assert.equal(hz.result.totals.totalDeductionPaisa, 0);
  console.log(`# report: ${rep.people.length} people in ${ms.toFixed(0)} ms; Moon: ${t.present} on time, ${t.late} late, ${t.absent} absent, ${t.incomplete} incomplete, deductions PKR ${(t.totalDeductionPaisa / 100).toFixed(2)}`);
});

test("filters: one employee, one shift", async () => {
  const all = await h.as("admin", (c) => monthReport(c, { month: "2026-08" }));
  const moon = all.people.find((p) => p.full_name === "Moon")!;
  const one = await h.as("admin", (c) => monthReport(c, { month: "2026-08", employeeId: moon.employee_id }));
  assert.equal(one.people.length, 1);
  const n18 = await h.as("admin", (c) => monthReport(c, { month: "2026-08", shiftCode: "N18" }));
  assert.deepEqual(n18.people.map((p) => p.full_name).sort(), ["Aqsam", "Izhaq", "Nabeel", "Sibtain"]);
});

test("employees and managers cannot open reports", async () => {
  await rejects(h.as("e1", (c) => monthReport(c, { month: "2026-08" }), "aal1"), 403);
  await rejects(h.as("manager", (c) => monthReport(c, { month: "2026-08" }), "aal1"), 403);
});
