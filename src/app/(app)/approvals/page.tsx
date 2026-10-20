import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/ActionForm";
import { Empty } from "@/components/Empty";
import { PageHeader } from "@/components/PageHeader";
import { StatusChip } from "@/components/StatusChip";
import { withSession } from "@/server/session";
import { listApprovals } from "@/server/services/approvals";
import { fmtDate, fmtDateTime, humanize } from "@/lib/format";
import type { Approval } from "@/lib/types";
import { approveAll, decide } from "./actions";

export const metadata: Metadata = { title: "Approvals" };

const TABS = [
  { key: "mine", label: "Waiting for me", query: { mine: true } },
  { key: "pending", label: "All pending", query: { status: "pending" } },
  { key: "decided", label: "Decided", query: {} },
] as const;

const ORDER = ["request", "leave", "from", "to", "day", "time_to_add", "part", "paid", "filed_after_window", "employee", "enrollment_no", "name_in_file", "device", "setting", "value", "source"];
const show = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? fmtDate(v) : typeof v === "object" ? JSON.stringify(v) : String(v);

function Subject({ a }: { a: Approval }) {
  if (!a.subject) return null;
  const rows = Object.entries(a.subject).filter(([, v]) => v !== null && v !== "")
    .sort(([x], [y]) => (ORDER.indexOf(x) + 1 || 99) - (ORDER.indexOf(y) + 1 || 99));
  return (
    <dl className="mt-2 grid gap-x-4 gap-y-1 rounded-md bg-surface-2 px-3 py-2 text-[13.5px] sm:grid-cols-2">
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-2"><dt className="text-ink-3">{humanize(k)}</dt>
          <dd className="font-medium">{show(v)}</dd></div>
      ))}
    </dl>
  );
}

export default async function Approvals({ searchParams }: { searchParams: Promise<{ tab?: string; mine?: string }> }) {
  const sp = await searchParams;
  const tab = TABS.find((t) => t.key === (sp.tab ?? (sp.mine ? "mine" : "mine"))) ?? TABS[0];
  let items = await withSession((c) => listApprovals(c, { ...tab.query, limit: 200 }));
  if (tab.key === "decided") items = items.filter((a) => a.status !== "pending");
  return (
    <>
      <PageHeader title="Approvals"
        lede="Every change that affects attendance, pay or records waits here. You can't approve your own requests, and decisions can't be edited afterwards." />
      <nav aria-label="Approval lists" className="mb-5 flex gap-1 border-b border-line">
        {TABS.map((t) => (
          <Link key={t.key} href={`?tab=${t.key}`} aria-current={t.key === tab.key ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-[14.5px] font-medium ${t.key === tab.key ? "border-accent text-accent" : "border-transparent text-ink-2 hover:text-ink"}`}>
            {t.label}</Link>
        ))}
      </nav>
      {tab.key === "mine" && items.filter((a) => a.can_decide && a.kind !== "deduction").length > 1 ? (
        <section className="panel mb-4 p-4">
          <ActionForm action={approveAll} submit={`Approve all ${items.filter((a) => a.can_decide && a.kind !== "deduction").length}`} className="flex flex-wrap items-end gap-2">
            <div className="min-w-64 flex-1"><label className="label" htmlFor="bulk-reason">Reason (stored with every decision)</label>
              <input id="bulk-reason" name="reason" className="field" placeholder="Checked against the August sheet" required minLength={3} /></div>
          </ActionForm>
          <p className="mt-2 text-[13px] text-ink-3">Each request is still checked one by one: you can't approve your own, and deductions are never bulk-approved.</p>
        </section>
      ) : null}
      {items.length === 0 ? (
        <Empty title={tab.key === "mine" ? "Nothing is waiting for you" : "No requests here"}>
          {tab.key === "mine" ? "Requests raised by others that need your role will appear here." : null}
        </Empty>
      ) : (
        <ul className="space-y-3">
          {items.map((a) => (
            <li key={a.id} className="panel p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-semibold">{humanize(a.kind)}{a.subject_employee_name ? `: ${a.subject_employee_name}` : ""}</p>
                  <p className="text-[13.5px] text-ink-2">Requested by {a.requested_by_name ?? "a staff account"}, {fmtDateTime(a.requested_at)}. Needs {a.required_role}.</p>
                </div>
                <StatusChip status={a.status} />
              </div>
              <p className="mt-2 text-[14.5px]">{a.reason}</p>
              <Subject a={a} />
              {a.decision_reason ? <p className="mt-2 text-[13.5px] text-ink-2">Decision note: {a.decision_reason} ({fmtDateTime(a.decided_at)})</p> : null}
              {a.can_decide ? (
                <ActionForm action={decide} submit="Record decision" className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
                  <input type="hidden" name="approval_id" value={a.id} />
                  <div><label className="label" htmlFor={`d-${a.id}`}>Decision</label>
                    <select id={`d-${a.id}`} name="decision" className="field"><option value="approved">Approve</option><option value="rejected">Reject</option></select></div>
                  <div className="min-w-56 flex-1"><label className="label" htmlFor={`r-${a.id}`}>Reason</label>
                    <input id={`r-${a.id}`} name="reason" className="field" required minLength={3} /></div>
                </ActionForm>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
