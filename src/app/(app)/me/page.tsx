import { CalendarCheck, CalendarX, Clock3, FileWarning, Plane, ShieldCheck, Wallet } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/ActionForm";
import { ChartCard, ClockInChart, HoursChart } from "@/components/charts";
import { DayRequest } from "@/components/DayRequest";
import { DocumentList } from "@/components/DocumentList";
import { Empty } from "@/components/Empty";
import { MonthPicker } from "@/components/MonthPicker";
import { StatusChip } from "@/components/StatusChip";
import { clock, fmtDate, fmtDateTime, hours, pkr, WEEKDAY } from "@/lib/format";
import { withSession } from "@/server/session";
import { checklist } from "@/server/services/documents";
import { getEmployee } from "@/server/services/employees";
import { myPayslips } from "@/server/services/payroll";
import { myMonthReport, myMonths } from "@/server/services/reports";
import { myRequests } from "@/server/services/requests";
import { salaryHistory } from "@/server/services/salary";
import { excuseAction, leaveAction } from "./actions";

export const metadata: Metadata = { title: "My records" };
const monthName = (m: string) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-01T00:00:00Z`));

export default async function MyRecords({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const sp = await searchParams;
  const data = await withSession(async (c) => {
    if (!c.employeeId) return null;
    const months = await myMonths(c);
    const month = sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : months[0] ?? new Date().toISOString().slice(0, 7);
    return { months, month, e: await getEmployee(c, c.employeeId), rep: await myMonthReport(c, month), docs: await checklist(c, c.employeeId),
      slips: await myPayslips(c), reqs: await myRequests(c), salary: await salaryHistory(c, c.employeeId),
      manager: (await c.tx<{ n: string | null }[]>`select hr.my_manager_name() as n`)[0]?.n ?? null,
      locked: (await c.tx<{ l: boolean }[]>`select hr.month_is_locked(${`${month}-01`}::date) as l`)[0]?.l ?? false };
  });
  if (!data) return <Empty title="Your login isn't linked to an employee record">Ask an Admin to link it.</Empty>;
  const { e, rep, month } = data;
  const p = rep.person;
  const t = p?.result.totals;
  // days that already have a request waiting (leave ranges cover every day in them)
  const waiting = data.reqs.filter((r) => r.status === "pending");
  const isWaiting = (d: string) => waiting.some((r) => d >= r.from_date && d <= r.to_date);
  const Fig = ({ icon: Icon, label, value, tone }: { icon: typeof Clock3; label: string; value: string; tone: string }) => (
    <div className="panel flex items-center gap-3 p-4"><span className={`grid size-10 place-items-center rounded-full ${tone}`}><Icon aria-hidden className="size-5" /></span>
      <div><p className="text-[12.5px] text-ink-3">{label}</p><p className="text-[20px] font-semibold tabular-nums">{value}</p></div></div>);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div><h1 className="text-[28px] font-semibold">Hello, {e.preferred_name ?? e.full_name.split(" ")[0]}</h1>
          <p className="mt-1 text-ink-3">Your attendance, pay and requests. Only you, HR and Admin can see this.</p></div>
        <MonthPicker months={data.months} value={month} />
      </div>

      {!p || !t ? <Empty title="No attendance for this month">Choose another month.</Empty> : (<>
        <section aria-label="This month" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Fig icon={CalendarCheck} label="On time" value={`${t.present} of ${t.scheduled} days`} tone="bg-ok-soft text-ok" />
          <Fig icon={Clock3} label="Late" value={`${t.late} day${t.late === 1 ? "" : "s"}, ${t.lateMinutes} min`} tone="bg-warn-soft text-warn" />
          <Fig icon={CalendarX} label="Absent" value={`${t.absent} day${t.absent === 1 ? "" : "s"}`} tone="bg-bad-soft text-bad" />
          <Fig icon={FileWarning} label="Needs review / excused" value={`${t.incomplete} / ${t.excused}`} tone="bg-review-soft text-review" />
        </section>

        <section className="panel grid gap-4 p-4 md:grid-cols-[1fr_auto]">
          <div>
            <h2 className="text-[15px] font-semibold">Pay for {monthName(month)} (before tax)</h2>
            {t.grossPaisa === null ? <p className="mt-1 text-[14px] text-ink-2">Your salary isn&apos;t set up yet. Ask HR.</p> : (
              <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 text-[14px] sm:grid-cols-4">
                <div><dt className="text-[12.5px] text-ink-3">Gross</dt><dd className="font-semibold tabular-nums">PKR {pkr(t.grossPaisa, 2)}</dd></div>
                <div><dt className="text-[12.5px] text-ink-3">Late cuts</dt><dd className="tabular-nums text-warn">{t.lateDeductionPaisa ? `−${pkr(t.lateDeductionPaisa, 2)}` : "0.00"}</dd></div>
                <div><dt className="text-[12.5px] text-ink-3">Absence / unpaid leave</dt><dd className="tabular-nums text-bad">{t.absenceDeductionPaisa + t.unpaidLeaveDeductionPaisa ? `−${pkr(t.absenceDeductionPaisa + t.unpaidLeaveDeductionPaisa, 2)}` : "0.00"}</dd></div>
                <div><dt className="text-[12.5px] text-ink-3">Net estimate</dt><dd className="text-[18px] font-bold tabular-nums">PKR {pkr(t.netPaisa, 2)}</dd></div>
              </dl>)}
            <p className="mt-2 text-[12.5px] text-ink-3">A day&apos;s salary is PKR {pkr(t.dailyRatePaisa, 2)} (salary ÷ {rep.policy.workingDaysDivisor}); each late day costs PKR {pkr(t.latePenaltyPaisa, 2)} ({rep.policy.latePercentOfDay}%). Late means more than {rep.policy.graceMinutes} min after your shift starts. Single-punch days are never cut.</p>
          </div>
          <div className="text-[13.5px] md:text-right"><p className="text-ink-3">Shift</p><p className="font-semibold">{p.shift?.name ?? "Not set"}</p>
            <p className="text-ink-3">Monday to Friday</p></div>
        </section>

        {p.shift ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard title="Your clock-in time each day">
              <ClockInChart grace={rep.policy.graceMinutes} data={p.result.days.filter((d) => d.firstIn && d.scheduledStart && d.punches > 1).map((d) => ({
                date: d.date, minutes: Math.round((Date.parse(`${d.firstIn}Z`) - Date.parse(`${d.scheduledStart}Z`)) / 60000), late: d.status === "late" }))} />
            </ChartCard>
            <ChartCard title="Hours worked per night">
              <HoursChart scheduled={Math.round(p.shift.durationMin / 60)} data={p.result.days.filter((d) => d.workedMinutes).map((d) => ({ date: d.date, hours: (d.workedMinutes ?? 0) / 60 }))} />
            </ChartCard>
          </div>) : null}

        <section className="panel overflow-visible">
          <h2 className="border-b border-line px-4 py-3 font-semibold">Every day in {monthName(month)}</h2>
          {data.locked ? <p className="border-b border-line bg-surface-2 px-4 py-2 text-[13px] text-ink-2">{monthName(month)} payroll is locked, so requests for this month go to HR or an Admin directly.</p> : null}
          <div className="overflow-x-auto">
            <table className="table min-w-[860px]">
              <thead><tr><th>Date</th><th>Shift starts</th><th>In</th><th>Out</th><th>Worked</th><th className="text-right">Late by</th><th>Status</th><th className="text-right">Cut</th><th>Request</th></tr></thead>
              <tbody>{p.result.days.filter((d) => d.status !== "rest" || d.punches > 0).filter((d) => d.status !== "not_employed").map((d) => {
                const kind = d.status === "late" ? "late" : d.status === "incomplete" ? "missing_punch" : d.status === "absent" ? "absent" : null;
                const asked = isWaiting(d.date);
                return (
                  <tr key={d.date}>
                    <td className="whitespace-nowrap">{WEEKDAY[d.weekday]} {fmtDate(d.date)}</td>
                    <td>{clock(d.scheduledStart)}</td><td>{clock(d.firstIn)}</td><td>{clock(d.lastOut)}</td><td>{hours(d.workedMinutes)}</td>
                    <td className={`text-right ${d.status === "late" ? "font-semibold text-warn" : ""}`}>{d.lateMinutes ? `${d.lateMinutes} min` : "—"}</td>
                    <td><StatusChip status={d.status} />{d.note ? <span className="block max-w-56 text-[12px] text-ink-3">{d.note}</span> : null}</td>
                    <td className="text-right tabular-nums">{d.deductionPaisa ? pkr(d.deductionPaisa, 2) : "—"}</td>
                    <td className="relative">{asked ? <StatusChip status="pending" /> : kind && !data.locked ? <DayRequest date={d.date} kind={kind} firstIn={d.firstIn} excuse={excuseAction} leave={leaveAction} /> : null}</td>
                  </tr>); })}</tbody>
            </table>
          </div>
        </section>
      </>)}

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="panel p-4">
          <h2 className="mb-3 flex items-center gap-2 text-[15px] font-semibold"><Plane aria-hidden className="size-4 text-accent" />Request leave</h2>
          <ActionForm action={leaveAction} submit="Send leave request" className="grid gap-3 sm:grid-cols-2">
            <div><label className="label" htmlFor="leave_type">Type</label>
              <select id="leave_type" name="leave_type" className="field"><option value="ANNUAL">Annual leave</option><option value="SICK">Sick leave</option>
                <option value="CASUAL">Casual leave</option><option value="UNPAID">Unpaid leave (deducted)</option></select></div>
            <div><label className="label" htmlFor="part_of_day">Length</label>
              <select id="part_of_day" name="part_of_day" className="field"><option value="full">Full day(s)</option><option value="first_half">First half (one day)</option><option value="second_half">Second half (one day)</option></select></div>
            <div><label className="label" htmlFor="start_date">From</label><input id="start_date" name="start_date" type="date" className="field" required /></div>
            <div><label className="label" htmlFor="end_date">To</label><input id="end_date" name="end_date" type="date" className="field" /></div>
            <div className="sm:col-span-2"><label className="label" htmlFor="reason">Reason</label><textarea id="reason" name="reason" rows={2} className="field" required minLength={3} /></div>
          </ActionForm>
          <p className="mt-2 text-[12.5px] text-ink-3">An Admin approves or declines it. Approved paid leave is never deducted; unpaid leave is deducted like an absence.</p>
        </section>

        <section className="panel">
          <h2 className="flex items-center gap-2 border-b border-line px-4 py-3 text-[15px] font-semibold"><ShieldCheck aria-hidden className="size-4 text-accent" />My requests</h2>
          {data.reqs.length ? (
            <ul className="max-h-[360px] divide-y divide-line overflow-y-auto">{data.reqs.map((r) => (
              <li key={r.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-2"><p className="text-[14px] font-medium">{r.title}</p><StatusChip status={r.status} /></div>
                <p className="text-[13px] text-ink-2">{r.detail}</p>
                <p className="text-[12px] text-ink-3">Sent {fmtDateTime(r.requested_at)}{r.late_filing ? ", after the 3-day window" : ""}
                  {r.decision_reason ? <>. Admin: <span className="text-ink-2">&ldquo;{r.decision_reason}&rdquo;</span></> : ""}</p>
              </li>))}</ul>
          ) : <p className="px-4 py-6 text-[13.5px] text-ink-3">No requests yet. Use the buttons in the table to explain a late day, fix a missing punch, or ask for leave.</p>}
        </section>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <section className="panel">
          <h2 className="flex items-center gap-2 border-b border-line px-4 py-3 text-[15px] font-semibold"><Wallet aria-hidden className="size-4 text-accent" />Payslips</h2>
          {data.slips.length ? (
            <ul className="divide-y divide-line">{data.slips.map((s) => (
              <li key={s.run_id} className="flex justify-between px-4 py-2.5"><Link className="font-medium text-accent hover:underline" href={`/payroll/${s.run_id}/${e.id}`}>{monthName(s.month)}</Link>
                <span className="tabular-nums">PKR {pkr(s.net_paisa, 2)}</span></li>))}</ul>
          ) : <p className="px-4 py-4 text-[13.5px] text-ink-3">Payslips appear once a month&apos;s payroll is locked.</p>}
          {data.salary[0] ? <p className="border-t border-line px-4 py-2.5 text-[13px] text-ink-2">Current salary PKR {pkr(Number(data.salary[0].salary_paisa))} from {fmtDate(data.salary[0].from)}</p> : null}
        </section>
        <section className="panel">
          <h2 className="border-b border-line px-4 py-3 text-[15px] font-semibold">About you</h2>
          <dl className="space-y-2.5 p-4 text-[14px]">
            <div><dt className="text-[12.5px] text-ink-3">Employee code</dt><dd>{e.employee_code}</dd></div>
            <div><dt className="text-[12.5px] text-ink-3">Role</dt><dd>{e.job_title ?? "—"}{e.department_name ? `, ${e.department_name}` : ""}</dd></div>
            <div><dt className="text-[12.5px] text-ink-3">Manager</dt><dd>{data.manager ?? e.manager_name ?? "—"}</dd></div>
            <div><dt className="text-[12.5px] text-ink-3">Joined</dt><dd>{fmtDate(e.joining_date)}</dd></div>
          </dl>
          <p className="border-t border-line px-4 py-2.5 text-[12.5px] text-ink-3">Something wrong? Raise it within 3 calendar days. <Link className="text-accent hover:underline" href={`/employees/${e.id}`}>See my timeline</Link></p>
        </section>
        <section className="panel">
          <h2 className="border-b border-line px-4 py-3 text-[15px] font-semibold">My documents</h2>
          <DocumentList employeeId={e.id} items={data.docs} canReview={false} />
        </section>
      </div>
    </div>
  );
}
