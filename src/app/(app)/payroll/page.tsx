import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/ActionForm";
import { Empty } from "@/components/Empty";
import { PageHeader } from "@/components/PageHeader";
import { StatusChip } from "@/components/StatusChip";
import { ChartCard, PayrollStack, Waterfall } from "@/components/charts";
import { fmtDateTime, pkr } from "@/lib/format";
import { withSession } from "@/server/session";
import { payrollMonth } from "@/server/services/payroll";
import { latestPunchMonth } from "@/server/services/reports";
import { calc, draft, lock, reopenRun, review } from "./actions";

export const metadata: Metadata = { title: "Payroll" };

export default async function Payroll({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const sp = await searchParams;
  const d = await withSession(async (c) => {
    const month = sp.month && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : await latestPunchMonth(c);
    return { m: await payrollMonth(c, month), isAdmin: c.isAdmin };
  }, { roles: ["admin", "hr"] });
  const { m } = d;
  const run = m.current;
  const total = (k: "gross_paisa" | "total_deductions_paisa" | "net_paisa") => m.lines.reduce((s, l) => s + Number(l[k]), 0);
  const part = (l: (typeof m.lines)[number], kind: string) => l.components.find((c) => c.kind === kind);

  return (
    <>
      <PageHeader title="Payroll"
        lede="Monthly pay from attendance and your rules: salary, minus late and absence cuts. Approve and lock to freeze the month and issue payslips. Tax is not calculated; pay people from your bank as usual."
        actions={run ? <a className="btn-quiet" href={`/api/payroll?run=${run.id}`}>Download CSV</a> : null} />

      <section className="panel mb-4 flex flex-wrap items-center justify-between gap-4 p-4">
        <div>
          <p className="text-[13px] text-ink-3">{new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m.month}-01T00:00:00Z`))}{run ? `, version ${run.version}` : ""}</p>
          <p className="mt-1 flex items-center gap-2 text-lg font-semibold">
            {run ? <StatusChip status={run.status === "under_review" ? "pending" : run.status} /> : <StatusChip status="missing" />}
            {run ? (run.status === "locked" ? "Locked: payslips issued" : run.status === "draft" ? "Draft: check the figures" : "Waiting for approval") : "Not calculated yet"}
          </p>
          {m.approval ? <p className="mt-1 text-[13px] text-ink-2">Approved {fmtDateTime(m.approval.approved_at)}{m.approval.approver ? ` by ${m.approval.approver}` : ""}: {m.approval.note}</p> : null}
          {run?.reopen_reason ? <p className="mt-1 text-[13px] text-ink-2">Reopened because: {run.reopen_reason}</p> : null}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {!run || run.status === "draft" ? (
            <ActionForm action={calc} submit={run ? "Recalculate" : "Calculate payroll"} variant={run ? "quiet" : "primary"} pending="Calculating…" className="flex items-end gap-2">
              <input type="hidden" name="month" value={m.month} /></ActionForm>) : null}
          {run && (run.status === "draft" || run.status === "under_review") && d.isAdmin ? (
            <ActionForm action={lock} submit="Approve and lock" pending="Locking…" className="flex items-end gap-2">
              <input type="hidden" name="run_id" value={run.id} />
              <div><label className="label" htmlFor="note">Approval note</label>
                <input id="note" name="note" className="field w-56" placeholder={`${m.month} checked`} required minLength={3} /></div>
            </ActionForm>) : null}
          {run?.status === "draft" && !d.isAdmin ? (
            <ActionForm action={review} submit="Send for approval" variant="quiet"><input type="hidden" name="run_id" value={run.id} /></ActionForm>) : null}
          {run?.status === "under_review" ? (
            <ActionForm action={draft} submit="Back to draft" variant="quiet"><input type="hidden" name="run_id" value={run.id} /></ActionForm>) : null}
          {run?.status === "locked" && d.isAdmin ? (
            <ActionForm action={reopenRun} submit="Reopen" variant="danger" className="flex items-end gap-2">
              <input type="hidden" name="run_id" value={run.id} />
              <div><label className="label" htmlFor="reason">Why reopen?</label>
                <input id="reason" name="reason" className="field w-56" required minLength={5} placeholder="Missed commission" /></div>
            </ActionForm>) : null}
        </div>
      </section>

      {!run || !m.lines.length ? (
        <Empty title={run ? "No payslips in this run" : "Payroll hasn't been calculated for this month"}>
          Make sure the month&apos;s attendance file is uploaded and employees have salaries, then click Calculate payroll.
        </Empty>
      ) : (
        <>
        <div className="mb-4 grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <ChartCard title="Employee payroll breakdown">
            <PayrollStack data={m.lines.filter((l) => l.gross_paisa > 0).map((l) => ({ name: l.full_name, net: l.net_paisa,
              lateCut: -(part(l, "late")?.amount_paisa ?? 0), absenceCut: -(part(l, "absence")?.amount_paisa ?? 0) }))} />
          </ChartCard>
          <ChartCard title="Company payroll waterfall">
            <Waterfall gross={total("gross_paisa")} late={m.lines.reduce((s, l) => s - (part(l, "late")?.amount_paisa ?? 0), 0)}
              absence={m.lines.reduce((s, l) => s - (part(l, "absence")?.amount_paisa ?? 0), 0)} />
          </ChartCard>
        </div>
        <div className="panel overflow-x-auto">
          <table className="table min-w-[1000px]">
            <thead><tr>
              <th scope="col">Employee</th><th scope="col" className="text-right">Monthly salary</th><th scope="col" className="text-right">Gross</th>
              <th scope="col" className="text-right">Late days</th><th scope="col" className="text-right">Late cut</th>
              <th scope="col" className="text-right">Absent days</th><th scope="col" className="text-right">Absence cut</th>
              <th scope="col" className="text-right">Total cuts</th><th scope="col" className="text-right">Net pay</th><th scope="col">Notes</th>
            </tr></thead>
            <tbody>{m.lines.map((l) => (
              <tr key={l.id}>
                <td className="whitespace-nowrap"><Link className="font-semibold hover:underline" href={`/payroll/${run.id}/${l.employee_id}`}>{l.full_name}</Link>
                  <span className="block text-[13px] text-ink-3">{l.employee_code}</span></td>
                <td className="text-right">{pkr(l.base_monthly_paisa)}</td>
                <td className="text-right">{pkr(l.gross_paisa, 2)}</td>
                <td className="text-right">{part(l, "late")?.days ?? 0}</td>
                <td className="text-right">{pkr(Math.abs(part(l, "late")?.amount_paisa ?? 0), 2)}</td>
                <td className="text-right">{part(l, "absence")?.days ?? 0}</td>
                <td className="text-right">{pkr(Math.abs(part(l, "absence")?.amount_paisa ?? 0), 2)}</td>
                <td className="text-right font-semibold text-warn">{pkr(l.total_deductions_paisa, 2)}</td>
                <td className="text-right text-[15px] font-bold">{pkr(l.net_paisa, 2)}</td>
                <td className="text-[12.5px] text-ink-2">{[part(l, "salary")?.note !== "full month" ? part(l, "salary")?.note : null, ...l.exceptions_snapshot.map((e) => e.note)].filter(Boolean).join("; ")}</td>
              </tr>))}</tbody>
            <tfoot><tr className="font-semibold">
              <td>Total ({m.lines.length})</td><td /><td className="text-right">{pkr(total("gross_paisa"), 2)}</td><td /><td /><td /><td />
              <td className="text-right">{pkr(total("total_deductions_paisa"), 2)}</td><td className="text-right">{pkr(total("net_paisa"), 2)}</td><td />
            </tr></tfoot>
          </table>
        </div>
        </>
      )}
      {m.runs.length > 1 ? (
        <p className="mt-3 text-[13px] text-ink-3">Earlier versions: {m.runs.filter((r) => r.id !== run?.id).map((r) => `version ${r.version} (${r.status})`).join(", ")}. Locked versions are kept permanently.</p>) : null}
    </>
  );
}
