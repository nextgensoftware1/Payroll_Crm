import type { Metadata } from "next";
import { ActionForm } from "@/components/ActionForm";
import { PageHeader } from "@/components/PageHeader";
import { StatusChip } from "@/components/StatusChip";
import { fmtDate } from "@/lib/format";
import { withSession } from "@/server/session";
import { listConfig, singleAdminMode } from "@/server/services/approvals";
import { change, submit } from "./actions";

export const metadata: Metadata = { title: "Settings" };

const LABELS: Record<string, [string, string]> = {
  "attendance.grace_minutes": ["Grace period", "minutes late before it counts"],
  "attendance.late_penalty_percent_of_day": ["Late deduction", "% of that day's salary"],
  "payroll.working_days_divisor": ["Working days per month", "a day's salary = monthly ÷ this"],
  "attendance.absence_penalty_days": ["Absence deduction", "days of salary per absent working day"],
  "attendance.near_duplicate_seconds": ["Double-press window", "seconds between punches flagged for review"],
  "attendance.dispute_window_days": ["Dispute window", "calendar days to dispute a record"],
  "alerts.probation_contract_lead_days": ["Probation/contract alerts", "days before the end date"],
};

export default async function Settings() {
  const { rows: all, auto } = await withSession(async (c) => ({ rows: await listConfig(c), auto: await singleAdminMode(c) }), { roles: ["admin", "hr"] });
  const rows = all.filter((r) => r.status !== "retired" && r.status !== "rejected");
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <PageHeader title="Settings" lede={auto ? "Rules the system uses. Changes apply straight away from the date you choose; earlier months keep the old value." : "Rules the system uses. Each change is sent for approval, and a different Admin must approve it before it applies."} />
      <div className="panel overflow-x-auto">
        <table className="table min-w-[760px]">
          <thead><tr><th scope="col">Rule</th><th scope="col" className="text-right">Value</th><th scope="col">From</th><th scope="col">Status</th><th scope="col">Source</th><th scope="col" /></tr></thead>
          <tbody>{rows.map((r) => {
            const [name, unit] = LABELS[r.key] ?? [r.key, ""];
            return (
              <tr key={r.id}>
                <td><span className="font-semibold">{name}</span><span className="block text-[13px] text-ink-3">{unit}</span></td>
                <td className="text-right text-[17px] font-semibold">{String(r.value)}</td>
                <td>{fmtDate(r.valid_from)}</td>
                <td><StatusChip status={r.status === "proposed" && r.approval_request_id ? "pending" : r.status} /></td>
                <td className="max-w-[34ch] text-[13px] text-ink-2">{r.source_reference}</td>
                <td>{r.status === "proposed" && !r.approval_request_id ? (
                  <ActionForm action={submit} submit={auto ? "Activate" : "Send for approval"} variant="quiet" className="space-y-1"><input type="hidden" name="id" value={r.id} /></ActionForm>
                ) : r.status === "approved" && !r.valid_to ? (
                  <ActionForm action={change} submit={auto ? "Change" : "Propose change"} variant="quiet" className="flex flex-wrap items-end gap-1.5">
                    <input type="hidden" name="key" value={r.key} />
                    <input name="value" type="number" step="any" defaultValue={String(r.value)} className="field w-20" aria-label={`New value for ${name}`} required />
                    <input name="from" type="date" defaultValue={today} className="field w-40" aria-label="Applies from" required />
                  </ActionForm>
                ) : null}</td>
              </tr>);
          })}</tbody>
        </table>
      </div>
    </>
  );
}
