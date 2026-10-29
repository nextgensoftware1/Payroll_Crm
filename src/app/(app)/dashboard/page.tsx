import { AlertTriangle, Banknote, CalendarClock, CheckCircle2, ClipboardCheck, Clock3, FileUp, Info, Receipt, Settings2, ShieldAlert, UserPlus, Users, Wallet } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { AttendanceByDay, ChartCard, DeductionsByEmployee, Dot, FinancialTrend, Sparkline, StatusDonut } from "@/components/charts";
import { MonthCalendar } from "@/components/MonthCalendar";
import { Register } from "@/components/Register";
import { processImportsInBackground } from "@/server/kick";
import { withSession } from "@/server/session";
import { singleAdminMode } from "@/server/services/approvals";
import { me as getMe, summary } from "@/server/services/dashboard";
import { overview } from "@/server/services/overview";

export const metadata: Metadata = { title: "Overview" };
const P = (p: number) => (p / 100).toLocaleString("en-PK", { maximumFractionDigits: 0 });
const when = (iso: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Karachi" }).format(new Date(iso));
const monthName = (m: string) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-01T00:00:00Z`));

function Delta({ now, before, goodWhenUp, prevMonth }: { now: number; before: number | undefined; goodWhenUp: boolean; prevMonth: string }) {
  if (before === undefined || before === 0) return <p className="text-[12px] text-ink-3">{before === 0 ? `none in ${prevMonth}` : "no earlier month"}</p>;
  const pct = ((now - before) / Math.abs(before)) * 100;
  const up = pct > 0, good = pct === 0 || up === goodWhenUp;
  return <p className="text-[12px] text-ink-3"><span className={`font-semibold ${good ? "text-ok" : "text-bad"}`}>{up ? "↑" : pct < 0 ? "↓" : ""} {Math.abs(pct).toFixed(1)}%</span>
    {!good ? <span className="text-bad"> (unfavourable)</span> : null} vs {prevMonth}</p>;
}

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ month?: string; day?: string }> }) {
  const sp = await searchParams;
  const d = await withSession(async (c) => {
    const [o, s, auto, me] = await Promise.all([
      overview(c, sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : null, sp.day),
      summary(c),
      singleAdminMode(c),
      getMe(c),
    ]);
    return { o, s, auto, me };
  }, { roles: ["admin", "hr"] });
  if (d.auto && d.s.batches_under_review > 0) processImportsInBackground();
  const { o } = d; const k = o.kpi; const pv = k.prev ?? undefined;
  const prevLabel = o.trend.length > 1 ? new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(new Date(`${o.trend.at(-2)!.month}-01T00:00:00Z`)) : "last month";
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "Asia/Karachi" }).format(new Date()));
  const greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const first = (d.me.employeeName ?? d.me.email ?? "").split(/[\s@]/)[0];
  const shifts = o.people.map((p) => p.shift).filter(Boolean) as string[];
  const mainShift = shifts.sort((a, b) => shifts.filter((x) => x === b).length - shifts.filter((x) => x === a).length)[0];
  const series = (f: (t: (typeof o.trend)[number]) => number) => o.trend.map(f);

  const kpis = [
    { label: "Total employees", value: String(k.employees), icon: Users, tone: "accent", now: k.employees, before: pv?.employees, up: true, spark: series((t) => t.employees) },
    { label: "Gross pay this month", value: `PKR ${P(k.gross)}`, icon: Wallet, tone: "accent", now: k.gross, before: pv?.gross, up: true, spark: series((t) => t.gross) },
    { label: "Calculated deductions", value: `PKR ${P(k.deductions)}`, icon: ShieldAlert, tone: "bad", now: k.deductions, before: pv?.deductions, up: false, spark: series((t) => t.deductions) },
    { label: "Net estimate", value: `PKR ${P(k.net)}`, icon: Banknote, tone: "ok", now: k.net, before: pv?.net, up: true, spark: series((t) => t.net) },
    { label: "Late days (all staff)", value: String(k.late), icon: Clock3, tone: "warn", now: k.late, before: pv?.late, up: false, spark: series((t) => t.late) },
    { label: "Days absent", value: String(k.absent), icon: CalendarClock, tone: "bad", now: k.absent, before: pv?.absent, up: false, spark: series((t) => t.absent) },
  ] as const;
  const toneBg = { accent: "bg-accent-soft text-accent", bad: "bg-bad-soft text-bad", ok: "bg-ok-soft text-ok", warn: "bg-warn-soft text-warn" } as const;
  const actIcon = { import: FileUp, payroll: Receipt, employee: UserPlus, rule: Settings2 } as const;

  return (
    <div className="grid gap-5 2xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0 space-y-5">
        <div className="flex flex-wrap items-stretch justify-between gap-4">
          <div><h1 className="text-[28px] leading-tight font-semibold tracking-[-0.01em]">{greet}{first ? `, ${first}` : ""}!</h1>
            <p className="mt-1 text-ink-3">Here&apos;s what happened at Empire Networks in {monthName(o.month)}.</p></div>
          <div className="relative flex min-w-64 items-center gap-3 overflow-hidden rounded-xl bg-navy px-4 py-3 text-white"
            style={{ backgroundImage: "linear-gradient(90deg, rgb(11 31 51 / 0.92) 35%, rgb(11 31 51 / 0.35)), url(/images/empire-hr-login-bg-960.webp)", backgroundSize: "cover", backgroundPosition: "center 62%" }}>
            <span aria-hidden className="text-[22px]">☾</span>
            <div><p className="text-[14px] font-semibold">Night shift operations</p><p className="text-[12.5px] text-white/80">{mainShift ?? "Shifts not set"} (Mon to Fri)</p></div>
          </div>
        </div>

        <section aria-label="Key figures" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 min-[1760px]:grid-cols-6">
          {kpis.map((x) => (
            <div key={x.label} className="panel p-4">
              <div className="flex items-start gap-3">
                <span className={`grid size-10 shrink-0 place-items-center rounded-full ${toneBg[x.tone]}`}><x.icon aria-hidden className="size-5" /></span>
                <div className="min-w-0"><p className="text-[12.5px] font-medium text-ink-3">{x.label}</p>
                  <p className="mt-0.5 text-[22px] leading-tight font-semibold whitespace-nowrap tabular-nums">{x.value}</p></div>
              </div>
              <div className="mt-2"><Delta now={x.now} before={x.before} goodWhenUp={x.up} prevMonth={prevLabel} /></div>
              <Sparkline data={x.spark} color={x.tone} />
            </div>))}
        </section>

        <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
          <ChartCard title="Attendance by working day"
            legend={<><Dot color="ok" label="On time" /><Dot color="warn" label="Late" /><Dot color="bad" label="Absent" /><Dot color="review" label="Needs review" /></>}
            table={<table className="table"><thead><tr><th>Day</th><th className="text-right">On time</th><th className="text-right">Late</th><th className="text-right">Absent</th><th className="text-right">Review</th></tr></thead>
              <tbody>{o.byDay.filter((x) => x.weekday <= 5).map((x) => <tr key={x.date}><td>{x.date}{x.holiday ? " (holiday)" : ""}</td><td className="text-right">{x.onTime}</td><td className="text-right">{x.late}</td><td className="text-right">{x.absent}</td><td className="text-right">{x.review}</td></tr>)}</tbody></table>}>
            <AttendanceByDay data={o.byDay} />
          </ChartCard>
          <ChartCard title="Deductions by employee (top 10)" legend={<><Dot color="warn" label="Late cut" /><Dot color="bad" label="Absence cut" /></>}
            table={<table className="table"><thead><tr><th>Employee</th><th className="text-right">Late</th><th className="text-right">Absence</th></tr></thead>
              <tbody>{o.top.map((p) => <tr key={p.id}><td>{p.name}</td><td className="text-right">{(p.lateCut / 100).toFixed(2)}</td><td className="text-right">{(p.absenceCut / 100).toFixed(2)}</td></tr>)}</tbody></table>}>
            <DeductionsByEmployee data={o.top} />
          </ChartCard>
        </div>

        <div className="grid min-w-0 gap-5 lg:grid-cols-2 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,0.95fr)]">
          <ChartCard title="Monthly financial trend"
            table={<table className="table"><thead><tr><th>Month</th><th className="text-right">Net pay</th><th className="text-right">Deductions</th></tr></thead>
              <tbody>{o.trend.map((t) => <tr key={t.month}><td>{t.month}</td><td className="text-right">{P(t.net)}</td><td className="text-right">{(t.deductions / 100).toFixed(2)}</td></tr>)}</tbody></table>}>
            <FinancialTrend data={o.trend} />
          </ChartCard>
          <ChartCard title="Where the working days went"
            table={<table className="table"><tbody>{o.split.map((x) => <tr key={x.key}><td>{x.label}</td><td className="text-right">{x.value}</td></tr>)}</tbody></table>}>
            <StatusDonut data={o.split} centre={String(o.workingDays)} centreLabel="working days" />
            <p className="mt-2 text-[12px] text-ink-3">Counts are employee-days across all staff with a shift.</p>
          </ChartCard>
          <div className="grid content-start gap-3">
            {o.alerts.noSalary.length ? (
              <div className="flex gap-3 rounded-xl border border-warn/30 bg-warn-soft p-4 text-[13.5px]"><AlertTriangle aria-hidden className="size-5 shrink-0 text-warn" />
                <div><p className="font-semibold">{o.alerts.noSalary.length} employee{o.alerts.noSalary.length === 1 ? " has" : "s have"} no salary yet</p>
                  <p className="text-ink-2">No money is shown for {o.alerts.noSalary.map((x) => x.name).join(", ")} until a salary is set.</p>
                  <Link className="font-medium text-accent hover:underline" href={`/employees/${o.alerts.noSalary[0]!.id}#salary`}>Set salary →</Link></div></div>) : null}
            {o.alerts.noShift.length ? (
              <div className="flex gap-3 rounded-xl border border-info/30 bg-info-soft p-4 text-[13.5px]"><Info aria-hidden className="size-5 shrink-0 text-info" />
                <div><p className="font-semibold">{o.alerts.noShift.length} employee{o.alerts.noShift.length === 1 ? " has" : "s have"} no shift</p>
                  <p className="text-ink-2">Lateness and absence can&apos;t be judged for {o.alerts.noShift.map((x) => x.name).join(", ")}.</p>
                  <Link className="font-medium text-accent hover:underline" href={`/employees/${o.alerts.noShift[0]!.id}`}>Open employee →</Link></div></div>) : null}
            {o.alerts.review ? (
              <div className="flex gap-3 rounded-xl border border-review/30 bg-review-soft p-4 text-[13.5px]"><ShieldAlert aria-hidden className="size-5 shrink-0 text-review" />
                <div><p className="font-semibold">{o.alerts.review} day{o.alerts.review === 1 ? "" : "s"} need review</p>
                  <p className="text-ink-2">Single-punch days are never deducted until HR checks them.</p>
                  <Link className="font-medium text-accent hover:underline" href={`/reports?month=${o.month}&sort=deduction`}>Open reports →</Link></div></div>) : null}
            <div className="flex gap-3 rounded-xl border border-line bg-surface p-4 text-[13.5px]"><Receipt aria-hidden className="size-5 shrink-0 text-accent" />
              <div><p className="font-semibold">Payroll for {monthName(o.month)}: {k.payrollStatus ? `${k.payrollStatus === "under_review" ? "waiting for approval" : k.payrollStatus}${k.payrollVersion ? `, version ${k.payrollVersion}` : ""}` : "not calculated yet"}</p>
                <Link className="font-medium text-accent hover:underline" href={`/payroll?month=${o.month}`}>{k.payrollStatus === "locked" ? "View payslips →" : "Open payroll →"}</Link></div></div>
          </div>
        </div>

        <Register data={o} />
        <p className="text-[12px] text-ink-3">Rules: late after {o.policy.graceMinutes} min grace costs {o.policy.latePercentOfDay}% of a day; a day = salary ÷ {o.policy.workingDaysDivisor}; absence = {o.policy.absenceDays} day. Pay before tax.</p>
      </div>

      <aside className="space-y-5">
        <section className="panel p-4">
          <h2 className="mb-3 text-[15px] font-semibold">Quick actions</h2>
          <div className="grid gap-2">
            <Link href="/attendance" className="btn-primary justify-start py-2.5"><FileUp aria-hidden className="size-4" />Upload attendance file</Link>
            <Link href={`/reports?month=${o.month}`} className="btn-quiet justify-start py-2.5"><ClipboardCheck aria-hidden className="size-4" />Generate report</Link>
            <Link href={`/payroll?month=${o.month}`} className="btn-quiet justify-start py-2.5"><Receipt aria-hidden className="size-4" />Run payroll</Link>
            <Link href="/approvals" className="btn-quiet justify-start py-2.5"><CheckCircle2 aria-hidden className="size-4" />View approvals</Link>
          </div>
        </section>
        <section className="panel p-4">
          <h2 className="mb-3 text-[15px] font-semibold">Recent activity</h2>
          {o.activity.length ? (
            <ol className="space-y-3">{o.activity.map((a, i) => { const Icon = actIcon[a.kind as keyof typeof actIcon] ?? Info; return (
              <li key={i} className="flex gap-3"><span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-accent"><Icon aria-hidden className="size-4" /></span>
                <div className="min-w-0"><p className="text-[13.5px] font-medium">{a.title}</p><p className="truncate text-[12.5px] text-ink-2">{a.detail}</p>
                  <p className="text-[11.5px] text-ink-3">{when(a.at)}</p></div></li>); })}</ol>
          ) : <p className="text-[13.5px] text-ink-3">Nothing yet.</p>}
        </section>
        <MonthCalendar month={o.month} days={o.calendar} focus={o.focusDay} />
      </aside>
    </div>
  );
}
