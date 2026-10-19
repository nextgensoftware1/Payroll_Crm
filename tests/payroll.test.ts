/** Payroll on the real August file: calculate -> approve and lock -> payslips -> reopen. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { runImportJobs } from "../src/server/jobs/attendance-import.ts";
import { uploadBatch } from "../src/server/services/attendance.ts";
import { approveAndLock, calculate, myPayslips, payrollMonth, payslip, reopen } from "../src/server/services/payroll.ts";
import { monthReport } from "../src/server/services/reports.ts";
import { setSalary } from "../src/server/services/salary.ts";
import { EMP, rejects, SAMPLE, setup } from "./harness.ts";

let h: Awaited<ReturnType<typeof setup>>;
let runId = "", moonId = "";
before(async () => {
  h = await setup();
  await h.owner`update hr.feature_flag set enabled = true where key = 'single_admin_mode'`;
  await h.as("hr", (c) => uploadBatch(c, h.storage, { newDevice: { name: "Gate" }, filename: "AUGUST.xls", data: SAMPLE }));
  await runImportJobs(h.storage);
  const rep = await h.as("admin", (c) => monthReport(c, { month: "2026-08" }));
  moonId = rep.people.find((p) => p.full_name === "Moon" && p.shift)!.employee_id;
  await h.as("hr", (c) => setSalary(c, { employee_id: moonId, salary_pkr: 52000, from_month: "2026-08" }));
  const nab = rep.people.find((p) => p.full_name === "Nabeel")!.employee_id;
  await h.as("hr", (c) => setSalary(c, { employee_id: nab, salary_pkr: 59000, from_month: "2026-08" }));
  // fixture employee e1 joined mid-month for the proration check
  await h.owner`update hr.employee set joining_date = '2026-08-17' where id = ${EMP.e1}`;
  await h.as("hr", (c) => setSalary(c, { employee_id: EMP.e1, salary_pkr: 44000, from_month: "2026-08" }));
});
after(async () => { await h.teardown(); });

test("payroll is on; payments and tax stay locked", async () => {
  const flags = Object.fromEntries((await h.owner`select key, enabled from hr.feature_flag`).map((r) => [r.key, r.enabled]));
  assert.deepEqual([flags.payroll_execution, flags.payment_execution, flags.tax_calculation, flags.late_deduction], [true, false, false, false]);
  await rejects(h.owner`update hr.feature_flag set enabled = true where key = 'payment_execution'`, 422);
});

test("calculate: one line per person with a salary; figures match the attendance report", async () => {
  const r = await h.as("hr", (c) => calculate(c, "2026-08"));
  runId = r.runId;
  assert.equal(r.lines, 3);
  const m = await h.as("hr", (c) => payrollMonth(c, "2026-08"));
  assert.equal(m.current!.status, "draft");
  const moon = m.lines.find((l) => l.employee_id === moonId)!;
  const rep = (await h.as("admin", (c) => monthReport(c, { month: "2026-08", employeeId: moonId }))).people[0]!.result.totals;
  assert.equal(moon.gross_paisa, 5_200_000);
  assert.equal(moon.total_deductions_paisa, rep.totalDeductionPaisa);
  assert.equal(moon.net_paisa, 5_200_000 - rep.totalDeductionPaisa);
  assert.equal(moon.components.find((c) => c.kind === "late")?.days, rep.late);
});

test("someone who joined mid-month gets a day's salary x working days employed", async () => {
  const m = await h.as("hr", (c) => payrollMonth(c, "2026-08"));
  const e1 = m.lines.find((l) => l.employee_id === EMP.e1)!;
  // 44,000 / 22 = 2,000 a day; 17-31 Aug = 11 working days
  assert.equal(e1.gross_paisa, 2_000_00 * 11);
  assert.match(e1.components[0]!.note!, /11 of 21 working days/);
});

test("approve and lock (single Admin); the snapshot is frozen", async () => {
  await rejects(h.as("hr", (c) => approveAndLock(c, runId, "ok")), 403);              // HR can't approve
  await h.as("admin", (c) => approveAndLock(c, runId, "August checked"));
  const m = await h.as("admin", (c) => payrollMonth(c, "2026-08"));
  assert.equal(m.current!.status, "locked");
  const [s] = await h.owner`select count(*)::int as n from hr.payroll_snapshot`;
  assert.equal(s!.n, 1);
  await rejects(h.as("hr", (c) => calculate(c, "2026-08")), 409, "locked");
  await rejects(h.owner`update hr.payroll_snapshot set content = '{}'`, 403);
});

test("payslips: the employee sees their own locked payslip, never someone else's", async () => {
  const mine = await h.as("e1", (c) => myPayslips(c), "aal1");
  assert.equal(mine.length, 1);
  assert.equal(mine[0]!.month, "2026-08");
  const p = await h.as("e1", (c) => payslip(c, runId, EMP.e1), "aal1");
  assert.equal(p.net_paisa, p.gross_paisa - p.total_deductions_paisa);
  await rejects(h.as("e1", (c) => payslip(c, runId, moonId), "aal1"), 404);
  await rejects(h.as("e2", (c) => payslip(c, runId, EMP.e1), "aal1"), 404);
});

test("reopen: the locked version is kept, a new draft is recalculated", async () => {
  await rejects(h.as("admin", (c) => reopen(c, runId, "no")), 422);
  const r = await h.as("admin", (c) => reopen(c, runId, "Late commission found"));
  assert.equal(r.reopened, true);
  await h.as("hr", (c) => calculate(c, "2026-08"));
  const m = await h.as("admin", (c) => payrollMonth(c, "2026-08"));
  assert.deepEqual(m.runs.map((x) => [x.version, x.status]), [[2, "draft"], [1, "superseded"]]);
  const [s] = await h.owner`select count(*)::int as n from hr.payroll_snapshot`;
  assert.equal(s!.n, 1); // original snapshot preserved
  assert.equal((await h.as("e1", (c) => myPayslips(c), "aal1")).length, 0); // superseded = no longer final
});

test("strict mode: the preparer cannot also approve payroll", async () => {
  await h.owner`update hr.feature_flag set enabled = false where key = 'single_admin_mode'`;
  const m = await h.as("admin", (c) => payrollMonth(c, "2026-08"));
  await rejects(h.as("hr", (c) => approveAndLock(c, m.current!.id, "self")), 403);
  await h.owner`update hr.payroll_run set prepared_by = ${"00000000-0000-0000-0000-0000000000a1"} where id = ${m.current!.id}`;
  await rejects(h.as("admin", (c) => approveAndLock(c, m.current!.id, "mine")), 409, "segregation");
  await h.as("admin2", (c) => approveAndLock(c, m.current!.id, "Second admin approves"));
  assert.equal((await h.as("admin", (c) => payrollMonth(c, "2026-08"))).current!.status, "locked");
});

test("payments still cannot be created", async () => {
  await rejects(h.as("admin", (c) => c.tx`insert into hr.payment_instruction (period_id, employee_id, run_id, amount_paisa, method)
    select pr.period_id, ${EMP.e1}::uuid, pr.id, 100, 'cash' from hr.payroll_run pr where pr.status = 'locked' limit 1`), 409, "payment_execution is OFF");
});
