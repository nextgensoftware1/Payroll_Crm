import type { Metadata } from "next";
import Link from "next/link";
import { Empty } from "@/components/Empty";
import { PageHeader } from "@/components/PageHeader";
import { StatusChip } from "@/components/StatusChip";
import { ChartCard, ClockInChart, HoursChart } from "@/components/charts";
import { clock, fmtDate, hours, pkr, WEEKDAY } from "@/lib/format";
import { withSession } from "@/server/session";
import { reference } from "@/server/services/dashboard";
import { latestPunchMonth, monthReport, shiftOptions } from "@/server/services/reports";

export const metadata: Metadata = { title: "Attendance reports" };

type SP = Promise<{ month?: string; employee?: string; department?: string; shift?: string; status?: string; sort?: string }>;
const STATUS_FILTERS = [["", "All days"], ["late", "Late"], ["absent", "Absent"], ["incomplete", "Needs review"], ["present", "On time"], ["rest_day_work", "Rest-day work"]] as const;
const SORTS = [["deduction", "Highest deductions"], ["late", "Most late days"], ["absent", "Most absences"], ["code", "Employee code"]] as const;

export default async function Reports({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const data = await withSession(async (c) => {
    const month = sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : await latestPunchMonth(c);
    const [ref, shifts, everyone] = [await reference(c), await shiftOptions(c), await monthReport(c, { month })];
    const filtered = everyone.people.filter((p) =>
      (!sp.employee || p.employee_id === sp.employee) && (!sp.department || p.department === sp.department) && (!sp.shift || p.shift?.code === sp.shift));
    return { month, ref, shifts, policy: everyone.policy, all: everyone.people, people: filtered };
  }, { roles: ["admin", "hr"] });
  const { month, policy, people, all } = data;
  const one = sp.employee ? people[0] : null;
  const qs = (over: Record<string, string | undefined>) => {
    const q = new URLSearchParams(Object.entries({ ...sp, month, ...over }).filter(([, v]) => v) as [string, string][]);
    return `?${q}`;
  };
  const sort = sp.sort ?? "deduction";
  const sorted = [...people].sort((a, b) =>
    sort === "late" ? b.result.totals.late - a.result.totals.late
    : sort === "absent" ? b.result.totals.absent - a.result.totals.absent
    : sort === "code" ? a.employee_code.localeCompare(b.employee_code)
    : b.result.totals.totalDeductionPaisa - a.result.totals.totalDeductionPaisa);
  const sum = (f: (t: (typeof people)[number]["result"]["totals"]) => number) => people.reduce((s, p) => s + f(p.result.totals), 0);
  const departments = [...new Set(all.map((p) => p.department).filter(Boolean))] as string[];

  return (
    <>
      <PageHeader title="Attendance reports"
        lede="Built from accepted imports and each person's shift. These are the same figures payroll uses; a month's pay is final only once its payroll is locked."
        actions={<a className="btn-quiet" href={`/api/reports/attendance${qs({})}`}>Download CSV</a>} />

      <form className="panel mb-4 grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-[repeat(5,minmax(0,1fr))_auto]" role="search">
        <div><label className="label" htmlFor="month">Month</label><input id="month" name="month" type="month" defaultValue={month} className="field" /></div>
        <div><label className="label" htmlFor="employee">Employee</label>
          <select id="employee" name="employee" defaultValue={sp.employee ?? ""} className="field">
            <option value="">Everyone ({all.length})</option>
            {all.map((p) => <option key={p.employee_id} value={p.employee_id}>{p.full_name} ({p.employee_code})</option>)}
          </select></div>
        <div><label className="label" htmlFor="department">Department</label>
          <select id="department" name="department" defaultValue={sp.department ?? ""} className="field">
            <option value="">All</option>{departments.map((d) => <option key={d} value={d}>{d}</option>)}</select></div>
        <div><label className="label" htmlFor="shift">Shift</label>
          <select id="shift" name="shift" defaultValue={sp.shift ?? ""} className="field">
            <option value="">All shifts</option>{data.shifts.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</select></div>
        <div><label className="label" htmlFor="status">{one ? "Show days" : "Sort by"}</label>
          {one ? (
            <select id="status" name="status" defaultValue={sp.status ?? ""} className="field">
              {STATUS_FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          ) : (
            <select id="status" name="sort" defaultValue={sort} className="field">
              {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          )}</div>
        <div className="flex items-end gap-2"><button className="btn-primary" type="submit">Show</button>
          <Link href="/reports" className="btn-quiet">Reset</Link></div>
      </form>

      <p className={`mb-4 rounded-md px-3 py-2 text-[13.5px] ${policy.approved ? "bg-surface-2 text-ink-2" : "bg-warn-soft text-warn"}`}>
        Rules: late if more than <b>{policy.graceMinutes} min</b> after shift start, <b>{policy.latePercentOfDay}%</b> of a day&apos;s salary per late day;
        a day&apos;s salary = monthly ÷ <b>{policy.workingDaysDivisor}</b>; absent working day = <b>{policy.absenceDays}</b> day&apos;s salary.
        Days with a single punch are &quot;Needs review&quot; and never deducted.
        {policy.approved ? null : <> These rules are <b>proposed, not yet approved</b>. <Link className="underline" href="/settings">Approve them in Settings</Link>.</>}
      </p>

      {!people.length ? (
        <Empty title="No one to show">Set up employees from an import (Attendance imports, open a batch, then &quot;Set up these people&quot;), or clear the filters.</Empty>
      ) : one ? <OnePerson p={one} status={sp.status ?? ""} month={month} /> : (
        <div className="panel overflow-x-auto">
          <table className="table min-w-[980px]">
            <thead><tr>
              <th scope="col">Employee</th><th scope="col">Shift</th><th scope="col" className="text-right">Salary</th>
              <th scope="col" className="text-right">Working days</th><th scope="col" className="text-right">On time</th>
              <th scope="col" className="text-right">Late</th><th scope="col" className="text-right">Absent</th>
              <th scope="col" className="text-right">Needs review</th><th scope="col" className="text-right">Deductions</th>
              <th scope="col" className="text-right">Net (estimate)</th>
            </tr></thead>
            <tbody>
              {sorted.map((p) => { const t = p.result.totals; return (
                <tr key={p.employee_id}>
                  <td><Link className="font-semibold hover:underline" href={qs({ employee: p.employee_id, sort: undefined })}>{p.full_name}</Link>
                    <span className="block text-[13px] text-ink-3">{p.employee_code}{p.department ? `, ${p.department}` : ""}</span></td>
                  <td>{p.shift?.name ?? <span className="text-bad">No shift set</span>}</td>
                  <td className="text-right">{pkr(p.salary_paisa)}{p.salary_status === "proposed" ? <span className="block text-[12px] text-warn">not approved</span> : null}</td>
                  <td className="text-right">{t.scheduled}</td><td className="text-right">{t.present}</td>
                  <td className={`text-right ${t.late ? "font-semibold text-warn" : ""}`}>{t.late}</td>
                  <td className={`text-right ${t.absent ? "font-semibold text-bad" : ""}`}>{t.absent}</td>
                  <td className={`text-right ${t.incomplete ? "text-accent" : ""}`}>{t.incomplete}</td>
                  <td className="text-right font-semibold">{pkr(t.totalDeductionPaisa, 2)}</td>
                  <td className="text-right">{pkr(t.netPaisa, 2)}</td>
                </tr>); })}
            </tbody>
            <tfoot><tr className="font-semibold">
              <td colSpan={2}>Total ({people.length})</td><td className="text-right">{pkr(people.reduce((s, p) => s + (p.salary_paisa ?? 0), 0))}</td>
              <td className="text-right">{sum((t) => t.scheduled)}</td><td className="text-right">{sum((t) => t.present)}</td>
              <td className="text-right">{sum((t) => t.late)}</td><td className="text-right">{sum((t) => t.absent)}</td>
              <td className="text-right">{sum((t) => t.incomplete)}</td><td className="text-right">{pkr(sum((t) => t.totalDeductionPaisa), 2)}</td>
              <td className="text-right">{pkr(sum((t) => t.netPaisa ?? 0), 2)}</td>
            </tr></tfoot>
          </table>
        </div>
      )}
    </>
  );
}

function OnePerson({ p, status, month }: { p: Awaited<ReturnType<typeof monthReport>>["people"][number]; status: string; month: string }) {
  const t = p.result.totals;
  const days = p.result.days.filter((d) => (status ? d.status === status : d.status !== "rest" || d.punches > 0));
  const tone: Record<string, string> = { present: "bg-ok", late: "bg-warn", absent: "bg-bad", incomplete: "bg-accent", rest_day_work: "bg-accent/50",
    rest: "bg-surface-2", upcoming: "bg-surface-2", leave: "bg-accent/40", holiday: "bg-accent/40" };
  return (
    <div className="space-y-4">
      <div className="panel p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xl font-bold">{p.full_name} <span className="text-[15px] font-normal text-ink-3">{p.employee_code}</span></h2>
          <span className="text-ink-2">{p.shift?.name ?? "No shift set"}, Monday to Friday, {new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`))}</span>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
          {([["Salary", pkr(p.salary_paisa)], ["A day's salary", pkr(t.dailyRatePaisa, 2)], ["Per late day", pkr(t.latePenaltyPaisa, 2)],
             ["On time", t.present], ["Late", `${t.late} (${t.lateMinutes} min)`], ["Absent", t.absent], ["Needs review", t.incomplete],
             ["Deductions", pkr(t.totalDeductionPaisa, 2)]] as const).map(([k, v]) => (
            <div key={k}><dt className="text-[13px] text-ink-3">{k}</dt><dd className="text-[17px] font-semibold">{v}</dd></div>))}
        </dl>
        <div aria-hidden className="mt-4 grid grid-cols-[repeat(31,minmax(0,1fr))] gap-0.5">
          {p.result.days.map((d) => <span key={d.date} title={`${d.date}: ${d.status}`} className={`h-3 rounded-sm ${tone[d.status]}`} />)}
        </div>
        <p className="mt-2 text-[13px] text-ink-3">Net estimate: <b>PKR {pkr(t.netPaisa, 2)}</b> (salary {pkr(t.monthlyPaisa)} − late {pkr(t.lateDeductionPaisa, 2)} − absence {pkr(t.absenceDeductionPaisa, 2)}).
          {p.salary_status === "proposed" ? " Salary not yet approved." : ""}</p>
      </div>
      {p.shift ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard title="Clock-in time each day (minutes from shift start)">
            <ClockInChart grace={10} data={p.result.days.filter((d) => d.firstIn && d.scheduledStart && d.punches > 1).map((d) => ({
              date: d.date, minutes: Math.round((Date.parse(`${d.firstIn}Z`) - Date.parse(`${d.scheduledStart}Z`)) / 60000), late: d.status === "late" }))} />
          </ChartCard>
          <ChartCard title="Hours worked per night">
            <HoursChart scheduled={Math.round(p.shift.durationMin / 60)} data={p.result.days.filter((d) => d.workedMinutes).map((d) => ({ date: d.date, hours: (d.workedMinutes ?? 0) / 60 }))} />
          </ChartCard>
        </div>) : (
        <p className="rounded-lg bg-info-soft px-3 py-2 text-[13.5px] text-info">No shift is set, so lateness and absence can&apos;t be judged. Set a shift on the employee page.</p>)}
      <div className="panel overflow-x-auto">
        <table className="table min-w-[860px]">
          <thead><tr><th scope="col">Date</th><th scope="col">Shift starts</th><th scope="col">In</th><th scope="col">Out</th>
            <th scope="col">Worked</th><th scope="col" className="text-right">Late by</th><th scope="col">Status</th>
            <th scope="col" className="text-right">Deduction</th><th scope="col">Note</th></tr></thead>
          <tbody>{days.map((d) => (
            <tr key={d.date}>
              <td className="whitespace-nowrap">{WEEKDAY[d.weekday]} {fmtDate(d.date)}</td>
              <td>{clock(d.scheduledStart)}</td><td>{clock(d.firstIn)}</td><td>{clock(d.lastOut)}</td>
              <td>{hours(d.workedMinutes)}</td>
              <td className={`text-right ${d.status === "late" ? "font-semibold text-warn" : ""}`}>{d.lateMinutes ? `${d.lateMinutes} min` : "—"}</td>
              <td><StatusChip status={d.status} /></td>
              <td className="text-right">{d.deductionPaisa ? pkr(d.deductionPaisa, 2) : "—"}</td>
              <td className="text-[13px] text-ink-2">{d.note ?? ""}</td>
            </tr>))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
