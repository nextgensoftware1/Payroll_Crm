import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/ActionForm";
import { AutoRefresh } from "@/components/AutoRefresh";
import { PageHeader } from "@/components/PageHeader";
import { PunchStrip } from "@/components/PunchStrip";
import { StatusChip } from "@/components/StatusChip";
import { withSession } from "@/server/session";
import { getBatch, listFlags, punches as getPunches } from "@/server/services/attendance";
import { singleAdminMode } from "@/server/services/approvals";
import { processImportsInBackground } from "@/server/kick";
import { listEmployees } from "@/server/services/employees";
import { fmtDate, fmtLocal, humanize } from "@/lib/format";
import type { Flag } from "@/lib/types";
import { decideBatch, proposeMapping, resolveKind } from "../actions";

export const metadata: Metadata = { title: "Review import" };

const KIND_HELP: Record<string, string> = {
  unknown_enrollment: "These enrollment numbers have no approved link to an employee. Their punches are kept but count for nobody until a mapping is approved.",
  name_mismatch: "The name in the file differs from the mapped employee. Check the device enrolment before accepting.",
  near_duplicate: "Two punches by the same person seconds apart, usually a double press. Both are kept; attendance treats them as one only after review.",
  direction_conflict: "The device's In/Out button was pressed inconsistently. Labels are stored as recorded but never trusted for pairing.",
  encoding_uncertain: "The file doesn't say which character set it uses. Check that names look right.",
  ambiguous_date: "Every date has day 12 or below, so day/month order can't be confirmed from this file alone.",
  outside_claimed_period: "Some rows fall outside the period you entered at upload.",
  future_timestamp: "Some punches are later than now. The device clock may be wrong.",
};

function summarize(f: Flag): string {
  const d = f.details as Record<string, unknown>;
  switch (f.kind) {
    case "unknown_enrollment": return `No. ${d.enrollment_no} (${d.name_seen ?? "no name"}), ${d.rows} rows`;
    case "near_duplicate": return `${d.name_seen ?? `No. ${d.enrollment_no}`}: rows ${d.first_row} and ${d.second_row}, ${d.seconds_apart} s apart`;
    case "name_mismatch": return `No. ${d.enrollment_no}: file says ${(d.name_seen as string[]).join(", ")}, mapped to ${d.expected_name}`;
    case "direction_conflict": return `${d.count} consecutive punches with the same label`;
    case "outside_claimed_period": return `${d.count} rows outside the period`;
    default: return f.row_number !== null ? `Row ${f.row_number}` : "Whole file";
  }
}

export default async function BatchPage({ params, searchParams }:
  { params: Promise<{ batchId: string }>; searchParams: Promise<{
    person?: string; dup?: string; salaryApproved?: string; salaryProposed?: string;
    salaryUnchanged?: string; salarySkipped?: string; salaryConflicts?: string;
  }> }) {
  const { batchId } = await params;
  const { person, dup, salaryApproved, salaryProposed, salaryUnchanged, salarySkipped, salaryConflicts } = await searchParams;
  const { b, flags, punches, employees, selected, auto } = await withSession(async (c) => {
    const b = await getBatch(c, batchId);
    const selected = person ?? b.people[0]?.enrollment_no;
    return {
      b, selected,
      flags: await listFlags(c, batchId),
      punches: selected ? await getPunches(c, batchId, selected) : [],
      employees: b.status === "under_review" ? await listEmployees(c, { status: "active", pageSize: 200 }) : null,
      auto: await singleAdminMode(c),
    };
  });
  const reviewing = b.status === "under_review" && !auto;
  if (b.status === "uploaded" || (auto && b.status === "under_review") || (b.status === "accepted" && b.promoted_punches === null)) processImportsInBackground();
  const open = flags.filter((f) => f.status === "open");
  const kinds = [...new Set(open.map((f) => f.kind))];
  const sel = b.people.find((p) => p.enrollment_no === selected);

  return (
    <>
      <PageHeader title={b.original_filename}
        lede={<span className="flex flex-wrap items-center gap-2"><StatusChip status={b.status} />
          {b.device_name}{b.claimed_start ? `, ${fmtDate(b.claimed_start)} to ${fmtDate(b.claimed_end)}` : ""}</span>}
        actions={<>
          {b.people.length ? <Link href={`/attendance/${b.id}/setup`} className="btn-primary">Set up these people</Link> : null}
          {b.status === "accepted" ? <Link href={`/reports?month=${(b.people[0]?.last_at ?? "").slice(0, 7)}`} className="btn-quiet">View report</Link> : null}
          <Link href="/attendance" className="btn-quiet">All imports</Link></>} />

      {dup ? <p role="status" className="mb-4 rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">That exact file was already uploaded. This is the existing import.</p> : null}
      {salaryApproved !== undefined || salaryProposed !== undefined ? (
        <div role="status" className="mb-4 rounded-md bg-ok-soft px-3 py-2 text-sm text-ok">
          CSV salary sync: {salaryApproved ?? "0"} salary changes applied
          {Number(salaryProposed) > 0 ? `, ${salaryProposed} awaiting Admin approval` : ""}
          {Number(salaryUnchanged) > 0 ? `, ${salaryUnchanged} already matched` : ""}
          {Number(salarySkipped) > 0 ? `, ${salarySkipped} skipped (missing or invalid CSV salary, or no employee link)` : ""}
          {Number(salaryConflicts) > 0 ? `, ${salaryConflicts} skipped because another salary change is already pending` : ""}.{" "}
          <Link className="font-semibold underline" href={`/dashboard?month=${(b.people[0]?.last_at ?? "").slice(0, 7)}`}>View dashboard</Link>
        </div>
      ) : null}
      {b.status === "uploaded" || b.status === "parsing" || (auto && b.status === "under_review") || (b.status === "accepted" && b.promoted_punches === null)
        ? <div className="mb-6"><AutoRefresh /></div> : null}
      {auto && b.status === "accepted" && b.promoted_punches !== null ? (
        <p role="status" className="mb-6 rounded-md bg-ok-soft px-3 py-2 text-sm text-ok">
          Done. {b.promoted_punches} new punches recorded{b.duplicate_punches ? `, ${b.duplicate_punches} were already in from earlier files` : ""}.{" "}
          <Link className="font-semibold underline" href={`/dashboard?month=${(b.people[0]?.last_at ?? "").slice(0, 7)}`}>See the month on the Overview</Link>
        </p>) : null}
      {b.status === "parse_failed" ? (
        <p role="alert" className="mb-6 rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">
          The file couldn't be read: {b.worker_error}. Check the export settings and upload it again.</p>
      ) : null}

      {b.total_rows !== null ? (
        <dl className="panel mb-6 grid grid-cols-2 divide-line sm:grid-cols-4 sm:divide-x">
          {[["Rows in file", b.total_rows], ["Could not read", b.error_rows ?? 0], ["People", b.people.length],
            [b.status === "accepted" ? "New punches recorded" : "Open flags", b.status === "accepted" ? b.promoted_punches ?? "…" : open.length]]
            .map(([k, v]) => <div key={k as string} className="px-4 py-3"><dt className="text-[13px] text-ink-3">{k}</dt><dd className="text-[24px] font-bold">{String(v)}</dd></div>)}
        </dl>
      ) : null}
      {b.status === "accepted" && b.duplicate_punches ? (
        <p className="mb-6 text-sm text-ink-2">{b.duplicate_punches} punches were already recorded from an earlier import and were not added again.</p>
      ) : null}
      {b.detected_source ? (
        <p className="mb-6 text-[13.5px] text-ink-3">Read as {b.detected_source.replace("_", " ").toUpperCase()} ({b.declared_extension} file), encoding {b.detected_encoding}.</p>
      ) : null}

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <section className="panel">
          <h2 className="border-b border-line px-4 py-3 font-semibold">{sel ? `${sel.name_seen ?? "No name"}, enrollment ${sel.enrollment_no}` : "Punches"}</h2>
          <div className="p-4">
            {sel ? (
              <>
                <p className="mb-4 text-[13.5px] text-ink-2">
                  {sel.employee_name ? <>Mapped to <Link className="font-medium text-accent hover:underline" href={`/employees/${sel.employee_id}`}>{sel.employee_name}</Link> ({sel.employee_code}).</>
                    : "Not linked to an employee yet."} {sel.rows} punches, {fmtLocal(sel.first_at)} to {fmtLocal(sel.last_at)} (device time).
                </p>
                {punches.length ? <PunchStrip punches={punches} /> : null}
                {!sel.employee_id && reviewing && employees ? (
                  <div className="mt-5 border-t border-line pt-4">
                    <h3 className="mb-2 font-semibold">Link enrollment {sel.enrollment_no} to an employee</h3>
                    <ActionForm action={proposeMapping} submit="Send for Admin approval" variant="quiet" className="grid gap-2 sm:grid-cols-2">
                      <input type="hidden" name="batch_id" value={b.id} />
                      <input type="hidden" name="device_id" value={b.device_id} />
                      <input type="hidden" name="enrollment_no" value={sel.enrollment_no} />
                      <input type="hidden" name="expected_name" value={sel.name_seen ?? ""} />
                      <div><label className="label" htmlFor="employee_id">Employee</label>
                        <select id="employee_id" name="employee_id" className="field" required defaultValue="">
                          <option value="" disabled>Choose…</option>
                          {employees.items.map((e) => <option key={e.id} value={e.id}>{e.full_name} ({e.employee_code})</option>)}</select></div>
                      <div><label className="label" htmlFor="valid_from">Number used since</label>
                        <input id="valid_from" name="valid_from" type="date" className="field" required /></div>
                      <p className="col-span-full text-[13px] text-ink-3">Names are never matched automatically. A different Admin must approve the link.</p>
                    </ActionForm>
                  </div>
                ) : null}
              </>
            ) : <p className="text-sm text-ink-2">No readable punches in this file.</p>}
          </div>
        </section>

        <div className="space-y-6">
          {reviewing ? (
            <section className="panel">
              <h2 className="border-b border-line px-4 py-3 font-semibold">{open.length ? `${open.length} flags to resolve` : "Ready to decide"}</h2>
              <div className="divide-y divide-line">
                {kinds.map((k) => {
                  const list = open.filter((f) => f.kind === k);
                  return (
                    <div key={k} className="space-y-2 px-4 py-4">
                      <h3 className="font-semibold">{humanize(k)} <span className="font-normal text-ink-3">({list.length})</span></h3>
                      <p className="text-[13.5px] text-ink-2">{KIND_HELP[k]}</p>
                      <ul className="max-h-40 space-y-0.5 overflow-y-auto text-[13.5px]">
                        {list.slice(0, 50).map((f) => <li key={f.id}>{summarize(f)}</li>)}
                      </ul>
                      <ActionForm action={resolveKind} submit={`Close ${list.length === 1 ? "this flag" : `all ${list.length}`}`} variant="quiet" className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="batch_id" value={b.id} />
                        <input type="hidden" name="kind" value={k} />
                        <div><label className="label" htmlFor={`st-${k}`}>Outcome</label>
                          <select id={`st-${k}`} name="status" className="field">
                            <option value="accepted_as_is">Checked, keep as is</option><option value="resolved">Fixed elsewhere</option></select></div>
                        <div className="min-w-44 flex-1"><label className="label" htmlFor={`n-${k}`}>What you checked</label>
                          <input id={`n-${k}`} name="note" className="field" required minLength={3} /></div>
                      </ActionForm>
                    </div>
                  );
                })}
                <div className="space-y-2 px-4 py-4">
                  <ActionForm action={decideBatch} submit="Record decision" className="space-y-2">
                    <input type="hidden" name="batch_id" value={b.id} />
                    <fieldset className="flex gap-4 text-[14.5px]">
                      <legend className="label">Decision</legend>
                      <label className="flex items-center gap-1.5"><input type="radio" name="decision" value="accept" disabled={open.length > 0} defaultChecked={!open.length} /> Accept</label>
                      <label className="flex items-center gap-1.5"><input type="radio" name="decision" value="reject" defaultChecked={open.length > 0} /> Reject</label>
                    </fieldset>
                    <label className="label" htmlFor="note">Review note</label>
                    <input id="note" name="note" className="field" required minLength={3} />
                    {open.length ? <p className="text-[13px] text-ink-3">Accept is available once every flag is closed.</p> : null}
                  </ActionForm>
                </div>
              </div>
            </section>
          ) : b.review_note ? (
            <section className="panel px-4 py-3 text-sm"><span className="font-semibold">Review note:</span> {b.review_note}</section>
          ) : null}

          <section className="panel">
            <h2 className="border-b border-line px-4 py-3 font-semibold">People in this file</h2>
            <ul className="max-h-[520px] divide-y divide-line overflow-y-auto">
              {b.people.map((p) => (
                <li key={p.enrollment_no}>
                  <Link href={`?person=${encodeURIComponent(p.enrollment_no)}`} aria-current={p.enrollment_no === selected ? "true" : undefined}
                    className={`flex items-center justify-between gap-2 px-4 py-2.5 text-[14.5px] hover:bg-surface-2 ${p.enrollment_no === selected ? "bg-accent-soft" : ""}`}>
                    <span><span className="font-medium">{p.name_seen ?? "No name"}</span>
                      <span className="block text-[13px] text-ink-3">No. {p.enrollment_no}{p.employee_code ? `, ${p.employee_code}` : ", not linked"}</span></span>
                    <span className="text-right text-[13px]">{p.rows} punches
                      {p.open_flags ? <span className="block font-semibold text-warn">{p.open_flags} flags</span> : null}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </>
  );
}
