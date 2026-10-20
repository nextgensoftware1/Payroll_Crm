"use client";
import { useState } from "react";
import { ActionForm } from "@/components/ActionForm";
import type { ActionState } from "@/lib/action-state";

type Action = (s: ActionState, f: FormData) => Promise<ActionState>;

/** Per-day request button in the employee's own table: Explain (late), Fix punch (single punch), Request leave (absent). */
export function DayRequest({ date, kind, excuse, leave, firstIn }: { date: string; kind: "late" | "missing_punch" | "absent"; excuse: Action; leave: Action; firstIn: string | null }) {
  const [open, setOpen] = useState(false);
  const label = kind === "late" ? "Explain" : kind === "missing_punch" ? "Fix punch" : "Request leave";
  const missingOut = kind === "missing_punch" && firstIn !== null && Number(firstIn.slice(11, 13)) >= 12;
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="btn-quiet px-2.5 py-1 text-[12.5px]">{label}</button>;
  return (
    <div className="w-72 rounded-lg border border-line bg-surface p-3 text-left shadow-lg">
      {kind === "absent" ? (
        <ActionForm action={leave} submit="Send leave request" className="space-y-2">
          <input type="hidden" name="start_date" value={date} /><input type="hidden" name="end_date" value={date} />
          <label className="label" htmlFor={`lt-${date}`}>Leave type</label>
          <select id={`lt-${date}`} name="leave_type" className="field py-1.5"><option value="SICK">Sick leave</option><option value="CASUAL">Casual leave</option>
            <option value="ANNUAL">Annual leave</option><option value="UNPAID">Unpaid leave (deducted)</option></select>
          <label className="label" htmlFor={`lr-${date}`}>Reason</label>
          <textarea id={`lr-${date}`} name="reason" rows={2} className="field" required minLength={3} />
        </ActionForm>
      ) : (
        <ActionForm action={excuse} submit="Send to Admin" className="space-y-2">
          <input type="hidden" name="kind" value={kind} /><input type="hidden" name="business_date" value={date} />
          {kind === "missing_punch" ? (
            <div>
              <label className="label" htmlFor={`pt-${date}`}>{missingOut ? "Time you clocked out" : "Time you clocked in"}</label>
              <div className="flex items-center gap-2">
                <input id={`pt-${date}`} name="punch_time" type="time" className="field w-32 py-1.5" required defaultValue={missingOut ? "02:00" : ""} />
                {missingOut ? <label className="flex items-center gap-1.5 text-[12.5px]"><input type="checkbox" name="punch_next_day" defaultChecked /> after midnight</label> : null}
              </div>
            </div>) : null}
          <label className="label" htmlFor={`er-${date}`}>{kind === "late" ? "Why were you late?" : "What happened?"}</label>
          <textarea id={`er-${date}`} name="reason" rows={2} className="field" required minLength={3} />
        </ActionForm>
      )}
      <button type="button" onClick={() => setOpen(false)} className="mt-2 text-[12.5px] text-ink-3 hover:text-ink">Cancel</button>
    </div>);
}
