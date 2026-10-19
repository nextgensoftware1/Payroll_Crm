/** Pay-rule engine: exact boundaries, night shifts, money in paisa. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { businessDate, computeMonth, dailyRate, latePenalty, type Policy, type Shift, suggestStartHour } from "../src/server/attendance/engine.ts";

const P: Policy = { graceMinutes: 10, latePercentOfDay: 4, workingDaysDivisor: 22, absenceDays: 1 };
const S17: Shift = { code: "N17", name: "5 PM to 2 AM", startMin: 17 * 60, durationMin: 9 * 60, windowBeforeMin: 180 };
const MF = [1, 2, 3, 4, 5];
const run = (punches: string[], extra: Partial<Parameters<typeof computeMonth>[0]> = {}) =>
  computeMonth({ month: "2026-08", now: "2026-10-19T12:00:00", shift: S17, workdays: MF, punches, monthlyPaisa: 5_200_000, policy: P, ...extra });
const day = (r: ReturnType<typeof run>, d: string) => r.days.find((x) => x.date === d)!;

test("money: 52,000 / 22 = 2,363.64 a day; 4% = 94.55", () => {
  const d = dailyRate(5_200_000, P);
  assert.equal(d, 236364);
  assert.equal(latePenalty(d, P), 9455);
});

test("a 2 AM punch belongs to the previous evening's shift", () => {
  assert.equal(businessDate("2026-08-04T02:05:00", S17), "2026-08-03");
  assert.equal(businessDate("2026-08-03T16:55:00", S17), "2026-08-03");
  assert.equal(businessDate("2026-08-03T13:59:00", S17), "2026-08-02");
});

test("exactly 10 minutes late is fine; 10 minutes 1 second is late", () => {
  const r = run(["2026-08-03T17:10:00", "2026-08-04T02:00:00", "2026-08-04T17:10:01", "2026-08-05T02:00:00"]);
  assert.equal(day(r, "2026-08-03").status, "present");
  assert.equal(day(r, "2026-08-04").status, "late");
  assert.equal(day(r, "2026-08-04").deductionPaisa, 9455);
});

test("early arrival is present, never negative lateness", () => {
  const d = day(run(["2026-08-03T16:40:00", "2026-08-04T02:10:00"]), "2026-08-03");
  assert.deepEqual([d.status, d.lateMinutes, d.workedMinutes], ["present", 0, 570]);
});

test("a missing working day is absent and costs one full day", () => {
  const r = run([]);
  assert.equal(day(r, "2026-08-03").status, "absent");          // Monday
  assert.equal(day(r, "2026-08-03").deductionPaisa, 236364);
  assert.equal(day(r, "2026-08-01").status, "rest");            // Saturday
  assert.equal(r.totals.scheduled, 21);                         // Mon-Fri in Aug 2026
  assert.equal(r.totals.absent, 21);
  assert.equal(r.totals.totalDeductionPaisa, 21 * 236364);
});

test("one punch only: flagged for review, no deduction", () => {
  const d = day(run(["2026-08-03T18:30:00"]), "2026-08-03");
  assert.deepEqual([d.status, d.deductionPaisa], ["incomplete", 0]);
});

test("rest-day work, leave and holidays are never deducted", () => {
  const r = run(["2026-08-01T17:00:00", "2026-08-02T02:00:00"], { leave: new Set(["2026-08-03"]), holidays: new Set(["2026-08-14"]) });
  assert.equal(day(r, "2026-08-01").status, "rest_day_work");
  assert.equal(day(r, "2026-08-03").status, "leave");
  assert.equal(day(r, "2026-08-14").status, "holiday");
  assert.equal(day(r, "2026-08-01").deductionPaisa + day(r, "2026-08-03").deductionPaisa + day(r, "2026-08-14").deductionPaisa, 0);
});

test("a shift that hasn't ended yet is not absent", () => {
  assert.equal(day(run([], { now: "2026-08-05T01:59:00" }), "2026-08-04").status, "upcoming"); // 4 Aug shift ends 02:00 on the 5th
  assert.equal(day(run([], { now: "2026-08-05T02:01:00" }), "2026-08-04").status, "absent");
  assert.equal(day(run([], { now: "2026-08-05T02:01:00" }), "2026-08-05").status, "upcoming");
});

test("without a salary the report still shows attendance, with no money", () => {
  const r = run([], { monthlyPaisa: null });
  assert.equal(r.totals.absent, 21);
  assert.equal(r.totals.totalDeductionPaisa, 0);
  assert.equal(r.totals.netPaisa, null);
});

test("net = salary - deductions (a whole month absent still leaves 1/22)", () => {
  const r = run([]);
  assert.equal(r.totals.netPaisa, 5_200_000 - 21 * 236364);
});

test("shift suggestion from real-looking punches", () => {
  assert.equal(suggestStartHour(["2026-08-03T16:42:00", "2026-08-04T02:00:00", "2026-08-04T16:50:00", "2026-08-05T17:05:00"]), 17);
  assert.equal(suggestStartHour(["2026-08-03T18:10:00"]), null);
});

test("days before joining or after leaving are not absences", () => {
  const r = run([], { employedFrom: "2026-08-17", employedTo: "2026-08-27" });
  assert.equal(day(r, "2026-08-03").status, "not_employed");
  assert.equal(day(r, "2026-08-31").status, "not_employed");
  assert.equal(r.totals.scheduled, 9);   // Mon 17 to Thu 27: 9 working days
  assert.equal(r.totals.absent, 9);
});

test("gross is prorated for a mid-month joiner and is the same number payroll uses", () => {
  const r = run([], { employedFrom: "2026-08-17", monthlyPaisa: 4_400_000 });
  assert.deepEqual([r.totals.fullMonthDays, r.totals.employedDays, r.totals.prorated], [21, 11, true]);
  assert.equal(r.totals.grossPaisa, 200_000 * 11);           // 44,000 / 22 = 2,000 a day
  assert.equal(r.totals.netPaisa, r.totals.grossPaisa! - r.totals.totalDeductionPaisa);
});
