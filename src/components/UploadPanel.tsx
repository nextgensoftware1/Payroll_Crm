"use client";
import { FileUp } from "lucide-react";
import { useActionState, useRef, useState } from "react";
import { FormMessage, SubmitButton } from "@/components/forms";
import type { ActionState } from "@/lib/action-state";
import type { Device } from "@/lib/types";

const ACCEPT = ".csv,.tsv,.txt,.xls,.dat";
const fmtSize = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Always-visible upload. With no devices yet, the same form creates one
 *  and the server reads its settings (Location ID, In/Out labels, date
 *  format) from the file itself. */
export function UploadPanel({ devices, action }: { devices: Device[]; action: (s: ActionState, f: FormData) => Promise<ActionState> }) {
  const [state, formAction] = useActionState(action, undefined);
  const [device, setDevice] = useState(devices[0]?.id ?? "new");
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const isNew = device === "new";

  function pick(f: File | undefined) {
    if (!f || !input.current) return;
    const dt = new DataTransfer();
    dt.items.add(f);
    input.current.files = dt.files;
    setFile(f);
  }

  return (
    <form action={formAction} className="space-y-4">
      <label
        htmlFor="file"
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files[0]); }}
        className={`flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center
          ${dragging ? "border-accent bg-accent-soft" : file ? "border-accent/60 bg-surface" : "border-line bg-surface-2 hover:border-accent/60"}`}
      >
        <FileUp aria-hidden className="size-7 text-accent" strokeWidth={1.75} />
        {file ? (
          <>
            <span className="font-semibold break-all">{file.name}</span>
            <span className="text-[13px] text-ink-2">{fmtSize(file.size)}. Click to choose a different file.</span>
          </>
        ) : (
          <>
            <span className="font-semibold">Choose the export file</span>
            <span className="text-[13px] text-ink-2">or drag it here. CSV, TXT or XLS from the device, up to 20 MB.</span>
          </>
        )}
        <input ref={input} id="file" name="file" type="file" accept={ACCEPT} required className="sr-only"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>

      <div>
        <label className="label" htmlFor="device_id">Device</label>
        <select id="device_id" name="device_id" className="field" value={device} onChange={(e) => setDevice(e.target.value)}>
          {devices.map((d) => <option key={d.id} value={d.id}>{d.name} (Location {d.location_code})</option>)}
          <option value="new">{devices.length ? "A new device…" : "New device (first upload)"}</option>
        </select>
      </div>

      {isNew ? (
        <div className="space-y-3 rounded-md border border-line bg-surface-2 p-3">
          <div>
            <label className="label" htmlFor="new_device_name">Device name</label>
            <input id="new_device_name" name="new_device_name" className="field" defaultValue={devices.length ? "" : "Main entrance"} required />
          </div>
          <p className="text-[13px] text-ink-2">Location ID, In/Out labels and the date format are read from the file. You don't need to type them.</p>
          <fieldset>
            <legend className="label">If the file's dates can't tell day from month</legend>
            <div className="flex flex-wrap gap-4 text-[14px]">
              <label className="flex items-center gap-1.5"><input type="radio" name="prefer" value="month_first" defaultChecked /> Month first (8/1 = 1 Aug)</label>
              <label className="flex items-center gap-1.5"><input type="radio" name="prefer" value="day_first" /> Day first (1/8 = 1 Aug)</label>
            </div>
          </fieldset>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <div><label className="label" htmlFor="claimed_start">Period from</label><input id="claimed_start" name="claimed_start" type="date" className="field" /></div>
        <div><label className="label" htmlFor="claimed_end">to</label><input id="claimed_end" name="claimed_end" type="date" className="field" /></div>
      </div>
      <p className="text-[13px] text-ink-3">Optional. After upload the file is read, new people are added, and the month appears on the Overview by itself. The same file can't be uploaded twice.</p>
      <FormMessage state={state} />
      <SubmitButton pendingText="Uploading…">Upload for review</SubmitButton>
    </form>
  );
}
