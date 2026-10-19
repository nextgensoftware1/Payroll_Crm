/** Single-admin mode (owner decision): upload a file and everything else is
 *  automatic: new people, shifts, links, acceptance, punches, report. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { runImportJobs } from "../src/server/jobs/attendance-import.ts";
import { changeConfig, listApprovals, listConfig } from "../src/server/services/approvals.ts";
import { getBatch, uploadBatch } from "../src/server/services/attendance.ts";
import { monthReport } from "../src/server/services/reports.ts";
import { salaryHistory, setSalary } from "../src/server/services/salary.ts";
import { rejects, SAMPLE, setup } from "./harness.ts";

// The fixture already has a "Moon" (EN-0001, no punches); the imported one gets EN-0001-xxxx.
type Rep = Awaited<ReturnType<typeof monthReport>>;
const imported = (rep: Rep, name: string) => rep.people.find((p) => p.full_name === name && p.shift !== null || (p.full_name === name && p.employee_code.length > 7))!;

let h: Awaited<ReturnType<typeof setup>>;
before(async () => {
  h = await setup();
  await h.owner`update hr.feature_flag set enabled = true where key = 'single_admin_mode'`;
});
after(async () => { await h.teardown(); });

test("upload once: batch accepted, 15 people created with shifts, 476 punches recorded", async () => {
  const id = await h.as("hr", (c) => uploadBatch(c, h.storage, { newDevice: { name: "Gate" }, filename: "AUGUST.xls", data: SAMPLE }));
  const done = await runImportJobs(h.storage);
  assert.deepEqual(done, { parsed: 1, autoAccepted: 1, promoted: 1 });
  const b = await h.as("hr", (c) => getBatch(c, id));
  assert.deepEqual([b.status, b.promoted_punches, b.open_flags], ["accepted", 476, 0]);
  assert.equal(b.people.filter((p) => p.employee_id).length, 15);
  const [{ n }] = await h.owner`select count(*)::int as n from hr.punch_mapping where status = 'approved'` as unknown as [{ n: number }];
  assert.equal(n, 15);
  const [audit] = await h.owner`select count(*)::int as n from hr.approval_decision where reason like 'Auto-approved%'`;
  assert.equal(audit!.n, 15); // every automatic step is recorded
});

test("the report fills in immediately: shifts from punches, no salary yet", async () => {
  const rep = await h.as("admin", (c) => monthReport(c, { month: "2026-08" }));
  const moon = imported(rep, "Moon");
  assert.match(moon.employee_code, /^EN-0001-[0-9A-F]{4}$/); // code clash avoided, never overwritten
  assert.equal(moon.shift?.name, "5 PM to 2 AM");
  assert.equal(moon.result.totals.scheduled, 21);
  assert.ok(moon.result.totals.present + moon.result.totals.late > 5);
  assert.equal(moon.salary_paisa, null);
  assert.equal(rep.policy.approved, true); // rules activated by migration 0012
  const nabeel = imported(rep, "Nabeel");
  assert.equal(nabeel.shift?.name, "6 PM to 3 AM");
  assert.equal(rep.people.find((p) => p.full_name === "Huzaifa")!.shift, null); // 1 day only
});

test("one Admin sets a salary: applies at once, deductions appear", async () => {
  const moonId = imported(await h.as("admin", (c) => monthReport(c, { month: "2026-08" })), "Moon").employee_id;
  assert.equal(await h.as("hr", (c) => setSalary(c, { employee_id: moonId, salary_pkr: 52000, from_month: "2026-08" })), true);
  const rep = await h.as("admin", (c) => monthReport(c, { month: "2026-08", employeeId: moonId }));
  const t = rep.people[0]!.result.totals;
  assert.equal(rep.people[0]!.salary_status, "approved");
  assert.equal(t.dailyRatePaisa, 236364);
  assert.equal(t.totalDeductionPaisa, t.late * 9455 + t.absent * 236364);

  // a raise from September keeps August's salary in history
  await h.as("hr", (c) => setSalary(c, { employee_id: moonId, salary_pkr: 60000, from_month: "2026-09" }));
  const hist = await h.as("hr", (c) => salaryHistory(c, moonId));
  assert.deepEqual(hist.map((x) => [Number(x.salary_paisa) / 100, x.from, x.to]), [[60000, "2026-09-01", null], [52000, "2026-08-01", "2026-09-01"]]);
  const aug = await h.as("admin", (c) => monthReport(c, { month: "2026-08", employeeId: moonId }));
  assert.equal(aug.people[0]!.salary_paisa, 5_200_000);
});

test("changing a rule applies at once and keeps the old value for earlier months", async () => {
  assert.equal(await h.as("hr", (c) => changeConfig(c, "attendance.grace_minutes", 15, "2026-09-01")), true);
  const g = (await h.as("hr", (c) => listConfig(c))).filter((r) => r.key === "attendance.grace_minutes" && r.status === "approved");
  assert.deepEqual(g.map((r) => [r.value, r.valid_from]).sort(), [[10, "2026-01-01"], [15, "2026-09-01"]]);
  assert.equal((await h.as("admin", (c) => monthReport(c, { month: "2026-08" }))).policy.graceMinutes, 10);
  await rejects(h.as("hr", (c) => changeConfig(c, "attendance.grace_minutes", 500, "2026-09-01")), 422);
});

test("nothing is left waiting, and re-uploading adds no punches", async () => {
  assert.equal((await h.as("admin", (c) => listApprovals(c, { status: "pending" }))).length, 0);
  const csv = new TextEncoder().encode(["No.,Name,Date/Time,Status,Location ID", "1,Moon,8/1/2026 3:06:51 AM,C/Out,101"].join("\n"));
  const [dev] = await h.owner`select id from hr.device where name = 'Gate'`;
  await h.as("hr", (c) => uploadBatch(c, h.storage, { deviceId: dev!.id, filename: "again.csv", data: csv }));
  await runImportJobs(h.storage);
  const [p] = await h.owner`select count(*)::int as n from hr.raw_punch`;
  assert.equal(p!.n, 476);
});

test("still locked even in single-admin mode: employees can't use it, payments and tax stay off", async () => {
  await rejects(h.as("e1", (c) => setSalary(c, { employee_id: "10000000-0000-0000-0000-0000000000e1", salary_pkr: 1, from_month: "2026-08" }), "aal1"), 403);
  await rejects(h.as("e1", (c) => c.tx`select hr.auto_decide(gen_random_uuid(), 'x')`, "aal1"), 409);
  const [f] = await h.owner`select bool_or(enabled) as on from hr.feature_flag where key in ('payment_execution', 'tax_calculation', 'late_deduction')`;
  assert.equal(f!.on, false);
});
