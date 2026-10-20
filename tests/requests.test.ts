/** Employee self-service: own records, requests, Admin decisions. Real August data. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { runImportJobs } from "../src/server/jobs/attendance-import.ts";
import { decide, listApprovals } from "../src/server/services/approvals.ts";
import { proposeMapping, uploadBatch } from "../src/server/services/attendance.ts";
import { monthReport, myMonthReport } from "../src/server/services/reports.ts";
import { myRequests, requestExcuse, requestLeave } from "../src/server/services/requests.ts";
import { setSalary } from "../src/server/services/salary.ts";
import { EMP, rejects, SAMPLE, setup, U } from "./harness.ts";

let h: Awaited<ReturnType<typeof setup>>;
const asMoon = <T>(fn: Parameters<typeof h.as<T>>[1]) => h.as<T>("e1", fn, "aal1");
const days = async () => (await asMoon((c) => myMonthReport(c, "2026-08"))).person!.result;
before(async () => {
  h = await setup();
  await h.owner`update hr.feature_flag set enabled = true where key = 'single_admin_mode'`;
  const [dev] = await h.owner`insert into hr.device (name, location_code, datetime_format, status_label_map)
    values ('Gate', '101', 'M/D/YYYY h:mm:ss AM', '{"C/In":"in","C/Out":"out"}') returning id`;
  await h.as("hr", (c) => proposeMapping(c, { device_id: dev!.id, enrollment_no: "1", employee_id: EMP.e1, expected_name: "Moon", valid_from: "2025-03-01" }));
  await h.owner`insert into hr.employee_calendar_assignment (employee_id, calendar_id, valid_during)
                values (${EMP.e1}, hr.ensure_shift_calendar(17), daterange('2025-03-01', null))`;
  await h.as("hr", (c) => setSalary(c, { employee_id: EMP.e1, salary_pkr: 52000, from_month: "2026-08" }));
  await h.as("hr", (c) => uploadBatch(c, h.storage, { deviceId: dev!.id, filename: "AUGUST.xls", data: SAMPLE }));
  await runImportJobs(h.storage);
});
after(async () => { await h.teardown(); });

test("Moon sees his own month: exactly the numbers HR and payroll see", async () => {
  const mine = await days();
  const hr = (await h.as("admin", (c) => monthReport(c, { month: "2026-08", employeeId: EMP.e1 }))).people[0]!.result;
  assert.deepEqual(mine.totals, hr.totals);
  assert.ok(mine.totals.present + mine.totals.late > 5);
  assert.equal(mine.totals.dailyRatePaisa, 236364);
});

test("he can't see anyone else's punches", async () => {
  const other = await h.as("e2", (c) => myMonthReport(c, "2026-08"), "aal1");
  assert.equal(other.person!.result.days.filter((d) => d.punches).length, 0); // Sibtain isn't mapped: no punches leak
  await rejects(asMoon((c) => monthReport(c, { month: "2026-08" })), 403);
});

test("explain a late day: validated, pending, Admins notified, NOT auto-approved", async () => {
  const late = (await days()).days.find((d) => d.status === "late")!;
  const onTime = (await days()).days.find((d) => d.status === "present")!;
  await rejects(asMoon((c) => requestExcuse(c, { kind: "late", business_date: onTime.date, reason: "test" })), 409, "isn't marked late");
  const id = await asMoon((c) => requestExcuse(c, { kind: "late", business_date: late.date, reason: "Bus broke down on Canal Road" }));
  await rejects(asMoon((c) => requestExcuse(c, { kind: "late", business_date: late.date, reason: "again" })), 409, "already have a request");
  const [r] = await h.owner`select status::text as s from hr.approval_request where id = ${id}`;
  assert.equal(r!.s, "pending"); // single-admin mode does not auto-approve employee requests
  const [n] = await h.owner`select count(*)::int as n from hr.notification where kind = 'request' and subject_id = ${id}`;
  assert.equal(n!.n, 2); // both real Admins
});

test("only a (different) Admin decides; approval removes that day's late cut and tells Moon", async () => {
  const before = (await days()).totals;
  const req = (await h.as("admin", (c) => listApprovals(c, { mine: true }))).find((a) => a.kind === "attendance_correction")!;
  assert.match(String(req.subject?.request), /late arrival/);
  await rejects(asMoon((c) => decide(c, req.id, { decision: "approved", reason: "approving my own" })), 409);
  await rejects(h.as("hr", (c) => decide(c, req.id, { decision: "approved", reason: "HR approving" })), 409, "admin");
  await h.as("admin", (c) => decide(c, req.id, { decision: "approved", reason: "Accepted: traffic incident" }));
  const after = (await days()).totals;
  assert.equal(after.excused, 1);
  assert.equal(after.late, before.late - 1);
  assert.equal(after.totalDeductionPaisa, before.totalDeductionPaisa - 9455);
  const [n] = await h.owner`select title from hr.notification where recipient_auth_user_id = ${U.e1} and kind = 'decision'`;
  assert.match(n!.title, /approved/);
});

test("fix a missing punch: the added time completes the day; raw punches untouched", async () => {
  const inc = (await days()).days.find((d) => d.status === "incomplete");
  if (!inc) return; // sample-dependent
  const rawBefore = (await h.owner`select count(*)::int as n from hr.raw_punch`)[0]!.n;
  const hasIn = Number(inc.firstIn!.slice(11, 13)) >= 12;
  const id = await asMoon((c) => requestExcuse(c, { kind: "missing_punch", business_date: inc.date, reason: "Forgot to punch out",
    punch_time: hasIn ? "02:05" : "17:00", punch_next_day: hasIn }));
  await h.as("admin", (c) => decide(c, id, { decision: "approved", reason: "Confirmed with team lead" }));
  const d = (await days()).days.find((x) => x.date === inc.date)!;
  assert.notEqual(d.status, "incomplete");
  assert.match(d.note ?? "", /approved request/);
  assert.equal((await h.owner`select count(*)::int as n from hr.raw_punch`)[0]!.n, rawBefore);
});

test("leave: paid leave on an absent day removes the absence cut; overlaps refused", async () => {
  const t0 = (await days()).totals;
  const absent = (await days()).days.find((d) => d.status === "absent");
  if (!absent) return; // sample-dependent
  const id = await asMoon((c) => requestLeave(c, { leave_type: "SICK", start_date: absent.date, end_date: absent.date, reason: "Fever" }));
  await rejects(asMoon((c) => requestLeave(c, { leave_type: "ANNUAL", start_date: absent.date, end_date: absent.date, reason: "dup" })), 409, "already have leave");
  await h.as("admin", (c) => decide(c, id, { decision: "approved", reason: "Medical note seen" }));
  const t1 = (await days()).totals;
  assert.equal(t1.absent, t0.absent - 1);
  assert.equal(t1.leave, t0.leave + 1);
  assert.equal(t1.totalDeductionPaisa, t0.totalDeductionPaisa - 236364);
});

test("unpaid leave is cut like an absence; a rejected request changes nothing", async () => {
  const id1 = await asMoon((c) => requestLeave(c, { leave_type: "UNPAID", start_date: "2026-09-07", end_date: "2026-09-08", reason: "Family wedding" }));
  await h.as("admin", (c) => decide(c, id1, { decision: "approved", reason: "Approved, unpaid" }));
  const sep = (await asMoon((c) => myMonthReport(c, "2026-09"))).person!.result;
  assert.equal(sep.totals.unpaidLeave, 2);
  assert.equal(sep.totals.unpaidLeaveDeductionPaisa, 2 * 236364);
  const id2 = await asMoon((c) => requestLeave(c, { leave_type: "CASUAL", start_date: "2026-09-14", end_date: "2026-09-14", reason: "Errand" }));
  await h.as("admin", (c) => decide(c, id2, { decision: "rejected", reason: "Month-end rush" }));
  const day = (await asMoon((c) => myMonthReport(c, "2026-09"))).person!.result.days.find((d) => d.date === "2026-09-14")!;
  assert.notEqual(day.status, "leave");
});

test("Moon's request history shows every request with the Admin's reason", async () => {
  const mine = await asMoon((c) => myRequests(c));
  assert.ok(mine.length >= 3);
  assert.ok(mine.some((r) => r.status === "rejected" && r.decision_reason === "Month-end rush"));
  assert.ok(mine.some((r) => r.kind === "late" && r.status === "approved"));
  await rejects(asMoon((c) => requestLeave(c, { leave_type: "ANNUAL", start_date: "2026-09-20", end_date: "2026-09-10", reason: "x y" })), 422);
});

test("a locked month can't be changed by a request", async () => {
  const { calculate, approveAndLock, payrollMonth } = await import("../src/server/services/payroll.ts");
  await h.as("hr", (c) => calculate(c, "2026-08"));
  const run = (await h.as("admin", (c) => payrollMonth(c, "2026-08"))).current!;
  await h.as("admin", (c) => approveAndLock(c, run.id, "August locked for test"));
  await rejects(asMoon((c) => requestLeave(c, { leave_type: "ANNUAL", start_date: "2026-08-31", end_date: "2026-08-31", reason: "Forgot to ask" })), 409, "payroll is already locked");
});
