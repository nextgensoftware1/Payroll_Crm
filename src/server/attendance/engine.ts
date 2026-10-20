/** Attendance + pay-rule engine. PURE: no database, no clock (today is passed in).
 *
 *  Business date: night shifts cross midnight, so a day "starts" at
 *  (shift start - clock-in window). With a 17:00 shift and a 3-hour window,
 *  every punch from 14:00 on Monday to 13:59 on Tuesday belongs to Monday.
 *
 *  Rules (owner decision 2026-10-19; values come from policy rows):
 *    late    = first punch more than `graceMinutes` after shift start
 *              (exactly 10:00 late is NOT late; 10:01 is)
 *    daily   = monthly salary / workingDaysDivisor            (paisa, rounded)
 *    late deduction    = daily x latePercentOfDay / 100 per late day
 *    absence deduction = daily x absenceDays per absent working day
 *  Never deducted: a day with a single punch (needs review), approved
 *  leave, approved holidays, rest days, and shifts that haven't ended yet. */

export type Shift = { code: string; name: string; startMin: number; durationMin: number; windowBeforeMin: number };
export type Policy = { graceMinutes: number; latePercentOfDay: number; workingDaysDivisor: number; absenceDays: number };
export type DayStatus = "present" | "late" | "absent" | "incomplete" | "leave" | "holiday" | "rest" | "rest_day_work" | "upcoming" | "not_employed" | "excused" | "unpaid_leave";

export type DayRow = {
  date: string; weekday: number; scheduled: boolean; scheduledStart: string | null;
  firstIn: string | null; lastOut: string | null; punches: number; workedMinutes: number | null;
  lateMinutes: number; status: DayStatus; deductionPaisa: number; note: string | null;
};

export type MonthResult = {
  days: DayRow[];
  totals: {
    scheduled: number; present: number; late: number; absent: number; incomplete: number; leave: number; holiday: number;
    excused: number; unpaidLeave: number; unpaidLeaveDeductionPaisa: number;
    restDayWork: number; lateMinutes: number; workedMinutes: number;
    dailyRatePaisa: number | null; latePenaltyPaisa: number | null;
    lateDeductionPaisa: number; absenceDeductionPaisa: number; totalDeductionPaisa: number;
    monthlyPaisa: number | null; grossPaisa: number | null; netPaisa: number | null;
    fullMonthDays: number; employedDays: number; prorated: boolean;
  };
};

const pad = (n: number) => String(n).padStart(2, "0");
const toEpochMin = (naive: string) => Date.parse(`${naive.length === 16 ? `${naive}:00` : naive}Z`) / 60000;
const fromEpochMin = (m: number) => new Date(m * 60000).toISOString().slice(0, 19);
const isoWeekday = (date: string) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

export function monthDays(month: string): string[] {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${pad(i + 1)}`);
}

/** Local window of punches needed for a month: [first day + boundary, day after last + boundary). */
export function punchWindow(month: string, shift: Shift): { from: string; to: string } {
  const days = monthDays(month);
  const boundary = shift.startMin - shift.windowBeforeMin;
  const from = toEpochMin(`${days[0]}T00:00:00`) + boundary;
  const to = toEpochMin(`${days.at(-1)}T00:00:00`) + 1440 + boundary;
  return { from: fromEpochMin(from), to: fromEpochMin(to) };
}

export function businessDate(punch: string, shift: Shift): string {
  return fromEpochMin(toEpochMin(punch) - (shift.startMin - shift.windowBeforeMin)).slice(0, 10);
}

export const dailyRate = (monthlyPaisa: number, p: Policy) => Math.round(monthlyPaisa / p.workingDaysDivisor);
export const latePenalty = (daily: number, p: Policy) => Math.round((daily * p.latePercentOfDay) / 100);

export function computeMonth(a: {
  month: string;
  now: string; // local wall clock 'YYYY-MM-DDTHH:MM:SS' (Asia/Karachi)
  shift: Shift | null; workdays: number[]; punches: string[];
  monthlyPaisa: number | null; policy: Policy; holidays?: Set<string>; leave?: Set<string>;
  employedFrom?: string | null; employedTo?: string | null; // joining date / exit date (inclusive)
  unpaidLeave?: Set<string>;   // approved UNPAID leave: deducted like an absence, shown as leave
  excusedLate?: Set<string>;   // approved late explanations: no late cut
  addedPunches?: string[];     // approved missing-punch fixes (local time); raw punches are never edited
}): MonthResult {
  const days = monthDays(a.month);
  const byDay = new Map<string, string[]>();
  const added = new Set(a.addedPunches ?? []);
  if (a.shift)
    for (const p of [...a.punches, ...added].sort()) {
      const d = businessDate(p, a.shift);
      byDay.set(d, [...(byDay.get(d) ?? []), p]);
    }
  const daily = a.monthlyPaisa !== null ? dailyRate(a.monthlyPaisa, a.policy) : null;
  const lateCut = daily !== null ? latePenalty(daily, a.policy) : null;
  const absenceCut = daily !== null ? Math.round(daily * a.policy.absenceDays) : null;

  const rows: DayRow[] = days.map((date) => {
    const weekday = isoWeekday(date);
    const employed = (!a.employedFrom || date >= a.employedFrom) && (!a.employedTo || date <= a.employedTo);
    const scheduled = employed && Boolean(a.shift) && a.workdays.includes(weekday);
    const ps = byDay.get(date) ?? [];
    const startMin = a.shift ? toEpochMin(`${date}T00:00:00`) + a.shift.startMin : null;
    const row: DayRow = {
      date, weekday, scheduled, scheduledStart: scheduled && startMin !== null ? fromEpochMin(startMin) : null,
      firstIn: ps[0] ?? null, lastOut: ps.length > 1 ? ps.at(-1)! : null, punches: ps.length,
      workedMinutes: ps.length > 1 ? Math.round(toEpochMin(ps.at(-1)!) - toEpochMin(ps[0]!)) : null,
      lateMinutes: 0, status: "rest", deductionPaisa: 0, note: null,
    };
    const shiftEnd = a.shift ? fromEpochMin(toEpochMin(`${date}T00:00:00`) + a.shift.startMin + a.shift.durationMin) : `${date}T23:59:59`;
    if (!employed) { row.status = "not_employed"; return row; }
    if (a.holidays?.has(date)) { row.status = "holiday"; return row; }
    if (a.leave?.has(date)) { row.status = "leave"; return row; }
    if (a.unpaidLeave?.has(date) && scheduled) { row.status = "unpaid_leave"; row.deductionPaisa = absenceCut ?? 0; row.note = "Approved unpaid leave."; return row; }
    if (!scheduled) { if (ps.length) { row.status = "rest_day_work"; row.note = "Worked on a rest day: not overtime unless approved."; } return row; }
    if (!ps.length) {
      if (shiftEnd > a.now) { row.status = "upcoming"; return row; } // shift not finished yet
      row.status = "absent";
      row.deductionPaisa = absenceCut ?? 0;
      return row;
    }
    if (ps.length === 1) {
      row.status = "incomplete";
      row.note = "Only one punch: needs HR review. No deduction until resolved.";
      return row;
    }
    const lateSeconds = (Date.parse(`${ps[0]}Z`) - Date.parse(`${row.scheduledStart}Z`)) / 1000;
    row.lateMinutes = Math.max(0, Math.ceil(lateSeconds / 60)); // 10 min 1 s shows as 11 min: never looks like it contradicts the 10-minute rule
    if (ps.some((p) => added.has(p))) row.note = "Includes a time added by an approved request.";
    if (lateSeconds > a.policy.graceMinutes * 60) {
      if (a.excusedLate?.has(date)) { row.status = "excused"; row.note = `Late by ${row.lateMinutes} min, excused by an Admin.`; }
      else { row.status = "late"; row.deductionPaisa = lateCut ?? 0; }
    } else row.status = "present";
    return row;
  });

  const count = (s: DayStatus) => rows.filter((r) => r.status === s).length;
  const lateDeduction = rows.filter((r) => r.status === "late").reduce((t, r) => t + r.deductionPaisa, 0);
  const absenceDeduction = rows.filter((r) => r.status === "absent").reduce((t, r) => t + r.deductionPaisa, 0);
  const unpaidLeaveDeduction = rows.filter((r) => r.status === "unpaid_leave").reduce((t, r) => t + r.deductionPaisa, 0);
  // Gross for THIS month: full salary, or a day's salary x working days employed
  // for someone who joined or left mid-month. One source for every screen.
  const prorationDays = a.shift ? a.workdays : [1, 2, 3, 4, 5];
  const fullMonthDays = days.filter((d) => prorationDays.includes(isoWeekday(d))).length;
  const employedDays = days.filter((d) => prorationDays.includes(isoWeekday(d))
    && (!a.employedFrom || d >= a.employedFrom) && (!a.employedTo || d <= a.employedTo)).length;
  const prorated = employedDays < fullMonthDays;
  const gross = a.monthlyPaisa === null ? null : prorated ? (daily ?? 0) * employedDays : a.monthlyPaisa;
  const allCuts = lateDeduction + absenceDeduction + unpaidLeaveDeduction;
  const total = gross === null ? allCuts : Math.min(gross, allCuts);
  return {
    days: rows,
    totals: {
      scheduled: rows.filter((r) => r.scheduled).length, present: count("present"), late: count("late"), absent: count("absent"),
      incomplete: count("incomplete"), leave: count("leave"), holiday: count("holiday"), restDayWork: count("rest_day_work"),
      excused: count("excused"), unpaidLeave: count("unpaid_leave"), unpaidLeaveDeductionPaisa: unpaidLeaveDeduction,
      lateMinutes: rows.filter((r) => r.status === "late").reduce((t, r) => t + r.lateMinutes, 0),
      workedMinutes: rows.reduce((t, r) => t + (r.workedMinutes ?? 0), 0),
      dailyRatePaisa: daily, latePenaltyPaisa: lateCut,
      lateDeductionPaisa: lateDeduction, absenceDeductionPaisa: absenceDeduction, totalDeductionPaisa: total,
      monthlyPaisa: a.monthlyPaisa, grossPaisa: gross, netPaisa: gross === null ? null : gross - total,
      fullMonthDays, employedDays, prorated,
    },
  };
}

/** Suggest a shift start hour from punches: median first punch after 12:00 per day, rounded to the hour. */
export function suggestStartHour(punches: string[]): number | null {
  const firstByDay = new Map<string, number>();
  for (const p of punches) {
    const h = Number(p.slice(11, 13)) + Number(p.slice(14, 16)) / 60;
    if (h < 12) continue;
    const d = p.slice(0, 10);
    if (!firstByDay.has(d) || h < firstByDay.get(d)!) firstByDay.set(d, h);
  }
  const v = [...firstByDay.values()].sort((x, y) => x - y);
  if (v.length < 3) return null;
  const mid = v.length % 2 ? v[(v.length - 1) / 2]! : (v[v.length / 2 - 1]! + v[v.length / 2]!) / 2;
  return Math.round(mid) % 24;
}
