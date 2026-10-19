import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/ActionForm";
import { PageHeader } from "@/components/PageHeader";
import { withSession } from "@/server/session";
import { reference } from "@/server/services/dashboard";
import { SHIFT_HOURS, setupCandidates, shiftLabel } from "@/server/services/setup";
import { runSetup } from "./actions";

export const metadata: Metadata = { title: "Set up people from import" };

export default async function SetupPage({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  const { cand, ref } = await withSession(async (c) => ({ cand: await setupCandidates(c, batchId), ref: await reference(c) }), { roles: ["admin", "hr"] });
  return (
    <>
      <PageHeader title="Set up people from this import"
        lede="Creates an employee for each enrollment number, assigns a Monday-to-Friday shift, and proposes a monthly salary and the enrollment link. Salaries and links only count after a different Admin approves them."
        actions={<Link href={`/attendance/${batchId}`} className="btn-quiet">Back to import</Link>} />
      <ActionForm action={runSetup} submit="Create and send for approval" pending="Setting up…" className="space-y-4">
        <input type="hidden" name="batch_id" value={batchId} />
        <div className="panel grid gap-3 p-4 sm:grid-cols-3">
          <div><label className="label" htmlFor="joining_date">Joining date (for everyone)</label>
            <input id="joining_date" name="joining_date" type="date" defaultValue={cand.monthStart ?? ""} className="field" required /></div>
          <div><label className="label" htmlFor="department_id">Department</label>
            <select id="department_id" name="department_id" className="field" defaultValue="">
              <option value="">Operations (create if missing)</option>
              {ref.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
          <p className="self-end text-[13px] text-ink-3">Shifts are suggested from each person&apos;s usual clock-in this month. Check them; you know the real rota.</p>
        </div>
        <div className="panel overflow-x-auto">
          <table className="table min-w-[900px]">
            <thead><tr><th scope="col">Add</th><th scope="col">No.</th><th scope="col">Employee code</th><th scope="col">Full name</th>
              <th scope="col">Shift (Mon to Fri)</th><th scope="col">Monthly salary (PKR)</th><th scope="col">Status</th></tr></thead>
            <tbody>
              {cand.people.map((p) => {
                const done = Boolean(p.mapping_status);
                return (
                  <tr key={p.enrollment_no}>
                    <td><input type="hidden" name="enrollment_no" value={p.enrollment_no} />
                      <input type="checkbox" name={`include_${p.enrollment_no}`} defaultChecked={!done} aria-label={`Add ${p.name_seen ?? p.enrollment_no}`} /></td>
                    <td>{p.enrollment_no}<span className="block text-[12px] text-ink-3">{p.rows} punches</span></td>
                    <td><input name={`code_${p.enrollment_no}`} className="field w-32 uppercase" defaultValue={`EN-${p.enrollment_no.padStart(4, "0")}`} aria-label="Employee code" /></td>
                    <td><input name={`name_${p.enrollment_no}`} className="field min-w-44" defaultValue={p.name_seen ?? ""} aria-label="Full name" /></td>
                    <td><select name={`shift_${p.enrollment_no}`} className="field" defaultValue={p.suggested_hour ?? ""} aria-label="Shift">
                      <option value="">Not set</option>
                      {SHIFT_HOURS.map((h) => <option key={h} value={h}>{shiftLabel(h)}{h === p.suggested_hour ? " (suggested)" : ""}</option>)}</select>
                      {p.suggested_hour === null ? <span className="block text-[12px] text-warn">Too few days to suggest</span> : null}</td>
                    <td><input name={`salary_${p.enrollment_no}`} className="field w-32 text-right" inputMode="numeric" defaultValue={p.demo_salary ?? ""} aria-label="Monthly salary" />
                      {p.demo_salary ? <span className="block text-[12px] text-ink-3">dummy value</span> : null}</td>
                    <td className="text-[13px]">{done ? <>Linked to {p.existing_employee} ({p.mapping_status})</> : <span className="text-ink-3">New</span>}</td>
                  </tr>);
              })}
            </tbody>
          </table>
        </div>
      </ActionForm>
    </>
  );
}
