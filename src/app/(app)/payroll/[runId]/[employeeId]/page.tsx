import type { Metadata } from "next";
import { PageHeader } from "@/components/PageHeader";
import { PrintButton } from "@/components/PrintButton";
import { StatusChip } from "@/components/StatusChip";
import { pkr } from "@/lib/format";
import { withSession } from "@/server/session";
import { payslip } from "@/server/services/payroll";

export const metadata: Metadata = { title: "Payslip" };
const monthName = (m: string) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-01T00:00:00Z`));
const LABEL: Record<string, string> = { salary: "Salary", late: "Late arrivals", absence: "Absences", excluded: "Not included" };

export default async function Payslip({ params }: { params: Promise<{ runId: string; employeeId: string }> }) {
  const { runId, employeeId } = await params;
  const p = await withSession((c) => payslip(c, runId, employeeId));
  return (
    <>
      <div className="print:hidden"><PageHeader title="Payslip" actions={<PrintButton />} /></div>
      <article className="panel mx-auto max-w-2xl p-6 print:border-0 print:p-0">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4">
          <div><p className="text-lg font-bold">Empire Networks Pvt Ltd</p><p className="text-ink-2">Payslip for {monthName(p.month)}</p></div>
          <StatusChip status={p.status === "locked" ? "locked" : p.status} />
        </header>
        <dl className="grid grid-cols-2 gap-3 py-4 text-[14.5px]">
          <div><dt className="text-[13px] text-ink-3">Employee</dt><dd className="font-semibold">{p.full_name}</dd></div>
          <div><dt className="text-[13px] text-ink-3">Code</dt><dd>{p.employee_code}</dd></div>
          <div><dt className="text-[13px] text-ink-3">Role</dt><dd>{[p.job_title, p.department].filter(Boolean).join(", ") || "—"}</dd></div>
          <div><dt className="text-[13px] text-ink-3">Monthly salary</dt><dd>PKR {pkr(p.base_monthly_paisa)}</dd></div>
        </dl>
        <div className="max-w-full overflow-x-auto">
          <table className="table min-w-[520px]">
            <thead><tr><th scope="col">Item</th><th scope="col">Detail</th><th scope="col" className="text-right">PKR</th></tr></thead>
            <tbody>{p.components.map((c, i) => (
              <tr key={i}><td>{LABEL[c.kind] ?? c.kind}</td>
                <td className="text-[13.5px] text-ink-2">{[c.days !== undefined ? `${c.days} day${c.days === 1 ? "" : "s"}` : null, c.minutes ? `${c.minutes} min late` : null, c.note].filter(Boolean).join(", ")}</td>
                <td className={`text-right ${c.amount_paisa < 0 ? "text-bad" : ""}`}>{c.amount_paisa < 0 ? "−" : ""}{pkr(Math.abs(c.amount_paisa), 2)}</td></tr>))}</tbody>
            <tfoot>
              <tr><td colSpan={2}>Gross</td><td className="text-right">{pkr(p.gross_paisa, 2)}</td></tr>
              <tr><td colSpan={2}>Total deductions</td><td className="text-right text-bad">−{pkr(p.total_deductions_paisa, 2)}</td></tr>
              <tr className="text-[17px] font-bold"><td colSpan={2}>Net pay</td><td className="text-right">PKR {pkr(p.net_paisa, 2)}</td></tr>
            </tfoot>
          </table>
        </div>
        {p.exceptions_snapshot.length ? <p className="mt-3 text-[13px] text-ink-2">Notes: {p.exceptions_snapshot.map((e) => e.note).join("; ")}.</p> : null}
        <p className="mt-4 border-t border-line pt-3 text-[12.5px] text-ink-3">
          Pay before tax; income tax is not calculated by this system. Version {p.version}. Questions about attendance can be raised with HR within 3 calendar days.
        </p>
      </article>
    </>
  );
}
