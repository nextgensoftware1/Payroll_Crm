import { ActionForm } from "@/components/ActionForm";
import { StatusChip } from "@/components/StatusChip";
import { reviewDocument, uploadDocument } from "@/app/(app)/employees/actions";
import { fmtDate, fmtDateTime } from "@/lib/format";
import type { ChecklistItem } from "@/lib/types";

export function DocumentList({ employeeId, items, canReview }: { employeeId: string; items: ChecklistItem[]; canReview: boolean }) {
  if (!items.length) return <p className="px-4 py-6 text-sm text-ink-2">No documents are required for this employment type.</p>;
  return (
    <ul className="divide-y divide-line">
      {items.map((d) => {
        const latest = d.versions[0];
        const reviewable = canReview && latest && !latest.review_decision;
        return (
          <li key={d.category_id} className="grid gap-3 px-4 py-4 md:grid-cols-[1fr_auto]">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{d.category_name}</span>
                <StatusChip status={d.status} />
                {d.required ? null : <span className="text-[13px] text-ink-3">Optional</span>}
              </div>
              {latest ? (
                <p className="mt-1 text-[13.5px] text-ink-2">
                  Version {latest.version_no}, uploaded {fmtDateTime(latest.uploaded_at)}{" "}
                  <a className="font-medium text-accent hover:underline" href={`/api/documents/${latest.id}`}>Download</a>
                  {latest.review_reason ? <span className="block text-ink-3">Review note: {latest.review_reason}</span> : null}
                </p>
              ) : <p className="mt-1 text-[13.5px] text-ink-3">Nothing uploaded yet.</p>}
              {d.expiry_date ? <p className="text-[13.5px] text-ink-2">Expires {fmtDate(d.expiry_date)}</p> : null}
              {reviewable ? (
                <ActionForm action={reviewDocument} submit="Save review" className="mt-3 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="version_id" value={latest.id} />
                  <input type="hidden" name="employee_id" value={employeeId} />
                  <div><label className="label" htmlFor={`dec-${latest.id}`}>Decision</label>
                    <select id={`dec-${latest.id}`} name="decision" className="field"><option value="accepted">Accept</option><option value="rejected">Reject</option></select></div>
                  <div className="min-w-48 flex-1"><label className="label" htmlFor={`why-${latest.id}`}>Reason</label>
                    <input id={`why-${latest.id}`} name="reason" className="field" placeholder="Matches original" required /></div>
                  {d.has_expiry ? <div><label className="label" htmlFor={`exp-${latest.id}`}>Expiry</label>
                    <input id={`exp-${latest.id}`} type="date" name="expiry_date" className="field" /></div> : null}
                </ActionForm>
              ) : null}
            </div>
            {d.status !== "accepted" && d.status !== "not_applicable" ? (
              <ActionForm action={uploadDocument} submit={latest ? "Upload new version" : "Upload"} pending="Uploading…" variant="quiet" className="flex flex-col gap-2 md:items-end">
                <input type="hidden" name="employee_id" value={employeeId} />
                <input type="hidden" name="category_id" value={d.category_id} />
                <label className="sr-only" htmlFor={`file-${d.category_id}`}>File for {d.category_name}</label>
                <input id={`file-${d.category_id}`} name="file" type="file" accept=".pdf,.jpg,.jpeg,.png" required className="text-sm" />
              </ActionForm>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
