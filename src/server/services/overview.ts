import "server-only";
import { monthDays } from "../attendance/engine.ts";
import { type Ctx, requireRole } from "../context.ts";
import { payrollStatusMonth } from "./payroll.ts";
import { monthChoices, monthReport, monthsWithPunches } from "./reports.ts";
import { measure, measureQuery } from "../perf.ts";

/** Everything the Overview shows, computed from real records with the same
 *  engine as Reports and Payroll, so every number agrees across screens. */

const prevMonth = (m: string) => { const [y, mo] = m.split("-").map(Number) as [number, number]; const d = new Date(Date.UTC(y, mo - 2, 1)); return d.toISOString().slice(0, 7); };
const wd = (d: string) => ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

type Rep = Awaited<ReturnType<typeof monthReport>>;
function totals(rep: Rep) {
  const s = (f: (p: Rep["people"][number]) => number) => rep.people.reduce((a, p) => a + f(p), 0);
  const withSalary = rep.people.filter((p) => p.salary_paisa !== null);
  return {
    employees: rep.people.length,
    gross: withSalary.reduce((a, p) => a + (p.result.totals.grossPaisa ?? 0), 0),
    deductions: withSalary.reduce((a, p) => a + p.result.totals.totalDeductionPaisa, 0),
    net: withSalary.reduce((a, p) => a + (p.result.totals.netPaisa ?? 0), 0),
    late: s((p) => p.result.totals.late), absent: s((p) => p.result.totals.absent),
    review: s((p) => p.result.totals.incomplete), onTime: s((p) => p.result.totals.present),
    leave: s((p) => p.result.totals.leave), lateMinutes: s((p) => p.result.totals.lateMinutes),
  };
}

export async function overview(ctx: Ctx, month: string | null, day?: string | null) {
  requireRole(ctx, "admin", "hr");
  return measure(`dashboard:${month}`, () => buildOverview(ctx, month, day));
}

async function buildOverview(ctx: Ctx, requestedMonth: string | null, day?: string | null) {
  const choices = requestedMonth ? null : await monthChoices(ctx);
  const month = requestedMonth ?? choices!.latest;
  const previousMonth = prevMonth(month);
  const initial = await measure("dashboard.initial-reports", () => Promise.all([
    monthReport(ctx, { month }),
    monthReport(ctx, { month: previousMonth }),
    choices ? Promise.resolve(choices.months) : monthsWithPunches(ctx),
  ]));
  const [rep, prev, availableMonths] = initial;
  const cur = totals(rep), before = prev.people.length ? totals(prev) : null;
  const payPromise = payrollStatusMonth(ctx, month);
  const activityPromise = measureQuery("dashboard.activity", () =>
    ctx.tx<{ at: string; kind: string; title: string; detail: string }[]>`
    select * from (
      select b.reviewed_at as at, 'import' as kind, 'Attendance import completed' as title,
             b.promoted_punches || ' punches recorded' || case when b.duplicate_punches > 0 then ', ' || b.duplicate_punches || ' already in' else '' end as detail
      from hr.attendance_import_batch b where b.status = 'accepted' and b.promoted_punches is not null
      union all
      select a.approved_at, 'payroll', 'Payroll approved and locked', to_char(pp.period_month, 'FMMonth YYYY') || ', version ' || r.version
      from hr.payroll_approval a join hr.payroll_run r on r.id = a.run_id join hr.payroll_period pp on pp.id = r.period_id
      union all
      select e.created_at, 'employee', 'New employee added', e.full_name || ' (' || e.employee_code || ')' from hr.employee e
      union all
      select pc.created_at, 'rule', 'Rule updated', replace(pc.key, '_', ' ') || ' = ' || pc.value::text
      from hr.policy_config pc where pc.source_reference like 'Changed in Settings%'
    ) x where at is not null order by at desc limit 6`
  );

  // 6-month trend from months that actually have data (never an invented percentage)
  const months = availableMonths.filter((m) => m <= month).slice(0, 6).reverse();
  const trendReports: Rep[] = await measure("dashboard.trend-reports", () => Promise.all(months.map((m) =>
    m === month ? Promise.resolve(rep)
      : m === previousMonth ? Promise.resolve(prev)
      : monthReport(ctx, { month: m }),
  )));
  const trend = months.map((m, i) => {
    const t = totals(trendReports[i]!);
    return { month: m, net: t.net, deductions: t.deductions, gross: t.gross, late: t.late, absent: t.absent, employees: t.employees };
  });

  // per working day: how many people were on time / late / absent / needs review
  const holidays = new Set<string>();
  const daysByPerson = rep.people.map((p) => new Map(p.result.days.map((d) => [d.date, d])));
  const byDay = monthDays(month).map((date) => {
    const c = { date, weekday: wd(date), onTime: 0, late: 0, absent: 0, review: 0, leave: 0, scheduled: 0, holiday: false };
    for (const personDays of daysByPerson) {
      const d = personDays.get(date)!;
      if (d.status === "holiday") { c.holiday = true; holidays.add(date); }
      if (d.scheduled) c.scheduled++;
      if (d.status === "present") c.onTime++; else if (d.status === "late") c.late++; else if (d.status === "absent") c.absent++;
      else if (d.status === "incomplete") c.review++; else if (d.status === "leave") c.leave++;
    }
    return c;
  });
  const workingDays = byDay.filter((d) => d.weekday <= 5).length;
  const lastWithData = [...byDay].reverse().find((d) => d.onTime + d.late + d.review > 0)?.date ?? byDay[0]!.date;
  const focusDay = day && byDay.some((d) => d.date === day) ? day : lastWithData;

  const people = rep.people.map((p, i) => {
    const t = p.result.totals;
    const d = daysByPerson[i]!.get(focusDay)!;
    return { id: p.employee_id, code: p.employee_code, name: p.full_name, department: p.department, shift: p.shift?.name ?? null,
      salary: p.salary_paisa, gross: t.grossPaisa, scheduled: t.scheduled, onTime: t.present, late: t.late, lateMinutes: t.lateMinutes,
      absent: t.absent, review: t.incomplete, deductions: p.salary_paisa === null ? null : t.totalDeductionPaisa, net: t.netPaisa,
      lateCut: t.lateDeductionPaisa, absenceCut: t.absenceDeductionPaisa,
      day: { status: d.status, in: d.firstIn, out: d.lastOut, lateMinutes: d.lateMinutes } };
  });

  const [pay, activity] = await Promise.all([payPromise, activityPromise]);

  return {
    month, focusDay, workingDays, policy: rep.policy,
    kpi: { ...cur, prev: before, payrollStatus: pay.current?.status ?? null, payrollVersion: pay.current?.version ?? null },
    trend, byDay, people,
    top: people.filter((p) => p.deductions).sort((a, b) => b.deductions! - a.deductions!).slice(0, 10),
    split: [
      { key: "onTime", label: "On time", value: cur.onTime }, { key: "late", label: "Late", value: cur.late },
      { key: "absent", label: "Absent", value: cur.absent }, { key: "review", label: "Needs review", value: cur.review },
    ],
    alerts: {
      noSalary: rep.people.filter((p) => p.salary_paisa === null).map((p) => ({ id: p.employee_id, name: p.full_name })),
      noShift: rep.people.filter((p) => !p.shift).map((p) => ({ id: p.employee_id, name: p.full_name })),
      review: cur.review, payroll: pay.current?.status ?? null,
    },
    activity: activity.map((a) => ({ ...a, at: String(a.at) })),
    calendar: byDay.map((d) => ({ date: d.date, weekday: d.weekday, holiday: d.holiday,
      rate: d.scheduled ? Math.round(((d.onTime + d.late + d.review) / Math.max(1, d.scheduled - d.leave)) * 100) : null, hasData: d.onTime + d.late + d.review > 0 })),
  };
}
export type Overview = Awaited<ReturnType<typeof overview>>;
