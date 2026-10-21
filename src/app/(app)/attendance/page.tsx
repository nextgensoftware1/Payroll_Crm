import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/ActionForm";
import { Empty } from "@/components/Empty";
import { PageHeader } from "@/components/PageHeader";
import { StatusChip } from "@/components/StatusChip";
import { UploadPanel } from "@/components/UploadPanel";
import { processImportsInBackground } from "@/server/kick";
import { withSession } from "@/server/session";
import { singleAdminMode } from "@/server/services/approvals";
import { listBatches, listDevices } from "@/server/services/attendance";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { createDevice, uploadBatch } from "./actions";

export const metadata: Metadata = { title: "Attendance imports" };

export default async function Attendance() {
  const { devices, batches, auto } = await withSession(async (c) => {
    const [devices, batches, auto] = await Promise.all([
      listDevices(c),
      listBatches(c),
      singleAdminMode(c),
    ]);
    return { devices, batches, auto };
  });
  if (batches.some((b) => b.status === "uploaded" || (auto && b.status === "under_review") || (b.status === "accepted" && b.promoted_punches === null))) processImportsInBackground();
  return (
    <>
      <PageHeader title="Attendance imports"
        lede="Upload the export from the biometric device. Every row is kept exactly as exported; nothing reaches attendance until you review and accept the batch." />
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section aria-labelledby="batches-h">
          <h2 id="batches-h" className="sr-only">Imports</h2>
          {batches.length === 0 ? (
            <Empty title="No imports yet">Export the month from the ZKTeco device (CSV if it offers it, otherwise XLS) and upload it with the panel on the right.</Empty>
          ) : (
            <div className="panel overflow-x-auto">
              <table className="table min-w-[680px]">
                <thead><tr><th scope="col">File</th><th scope="col">Period</th><th scope="col">Rows</th><th scope="col">Open flags</th><th scope="col">Status</th></tr></thead>
                <tbody>{batches.map((b) => (
                  <tr key={b.id}>
                    <td><Link className="font-semibold hover:underline" href={`/attendance/${b.id}`}>{b.original_filename}</Link>
                      <span className="block text-[13px] text-ink-3">{b.device_name}, uploaded {fmtDateTime(b.uploaded_at)}{b.uploaded_by_name ? ` by ${b.uploaded_by_name}` : ""}</span></td>
                    <td>{b.claimed_start ? `${fmtDate(b.claimed_start)} to ${fmtDate(b.claimed_end)}` : "—"}</td>
                    <td>{b.total_rows?.toLocaleString("en-PK") ?? "—"}</td>
                    <td className={b.open_flags ? "font-semibold text-warn" : ""}>{b.open_flags}</td>
                    <td><StatusChip status={b.status} /></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
        <aside className="space-y-6 lg:order-last">
          <section className="panel p-4">
            <h2 className="mb-3 font-semibold">Upload an export</h2>
            <UploadPanel devices={devices} action={uploadBatch} />
          </section>
          {devices.length ? (
            <details className="panel p-4">
              <summary className="cursor-pointer font-semibold">Add a device by hand</summary>
              <p className="mt-2 mb-3 text-[13.5px] text-ink-2">Usually not needed: choosing "A new device" when uploading reads these settings from the file.</p>
              <ActionForm action={createDevice} submit="Add device" variant="quiet">
                <div><label className="label" htmlFor="name">Name</label><input id="name" name="name" className="field" placeholder="Back gate" required /></div>
                <div><label className="label" htmlFor="location_code">Location ID in exports</label><input id="location_code" name="location_code" className="field" placeholder="102" required /></div>
                <div><label className="label" htmlFor="datetime_format">Date format</label>
                  <input id="datetime_format" name="datetime_format" className="field font-mono text-sm" defaultValue="M/D/YYYY h:mm:ss AM" required /></div>
                <div className="grid grid-cols-2 gap-2">
                  <div><label className="label" htmlFor="in_label">In label</label><input id="in_label" name="in_label" className="field" defaultValue="C/In" required /></div>
                  <div><label className="label" htmlFor="out_label">Out label</label><input id="out_label" name="out_label" className="field" defaultValue="C/Out" required /></div>
                </div>
              </ActionForm>
            </details>
          ) : null}
        </aside>
      </div>
    </>
  );
}
