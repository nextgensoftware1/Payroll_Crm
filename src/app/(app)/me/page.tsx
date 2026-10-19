import type { Metadata } from "next";
import Link from "next/link";
import { DocumentList } from "@/components/DocumentList";
import { Empty } from "@/components/Empty";
import { PageHeader } from "@/components/PageHeader";
import { withSession } from "@/server/session";
import { checklist } from "@/server/services/documents";
import { getEmployee } from "@/server/services/employees";
import { myPayslips } from "@/server/services/payroll";
import { pkr } from "@/lib/format";
import { fmtDate } from "@/lib/format";

export const metadata: Metadata = { title: "My records" };

export default async function MyRecords() {
  const data = await withSession(async (c) => c.employeeId
    ? { e: await getEmployee(c, c.employeeId), docs: await checklist(c, c.employeeId), slips: await myPayslips(c) } : null);
  if (!data)
    return (<><PageHeader title="My records" /><Empty title="Your login isn't linked to an employee record">Ask an Admin to link it.</Empty></>);
  const { e, docs, slips } = data;
  return (
    <>
      <PageHeader title={`Hello, ${e.preferred_name ?? e.full_name.split(" ")[0]}`}
        lede="Your own record. Only you, HR and Admin can see your documents." />
      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <section className="panel">
          <h2 className="border-b border-line px-4 py-3 font-semibold">About you</h2>
          <dl className="space-y-3 p-4 text-[15px]">
            <div><dt className="text-[13px] text-ink-3">Employee code</dt><dd>{e.employee_code}</dd></div>
            <div><dt className="text-[13px] text-ink-3">Role</dt><dd>{e.job_title ?? "—"}{e.department_name ? `, ${e.department_name}` : ""}</dd></div>
            <div><dt className="text-[13px] text-ink-3">Manager</dt><dd>{e.manager_name ?? "—"}</dd></div>
            <div><dt className="text-[13px] text-ink-3">Joined</dt><dd>{fmtDate(e.joining_date)}</dd></div>
            {e.probation ? <div><dt className="text-[13px] text-ink-3">Probation ends</dt><dd>{fmtDate(e.probation.end)}</dd></div> : null}
          </dl>
          <p className="border-t border-line px-4 py-2.5 text-[13px] text-ink-3">
            Something wrong? Tell HR. Attendance disputes can be raised within 3 calendar days of a record being available.
          </p>
          <div className="px-4 pb-4"><Link className="text-sm font-medium text-accent hover:underline" href={`/employees/${e.id}`}>See my timeline</Link></div>
        </section>
        <section className="panel lg:col-span-2">
          <h2 className="border-b border-line px-4 py-3 font-semibold">My payslips</h2>
          {slips.length ? (
            <ul className="divide-y divide-line">{slips.map((s) => (
              <li key={s.run_id} className="flex justify-between px-4 py-2.5">
                <Link className="font-medium text-accent hover:underline" href={`/payroll/${s.run_id}/${e.id}`}>{s.month}</Link>
                <span>Net PKR {pkr(s.net_paisa, 2)}</span></li>))}</ul>
          ) : <p className="px-4 py-4 text-sm text-ink-2">No payslips yet. They appear here once a month's payroll is locked.</p>}
        </section>
        <section className="panel">
          <h2 className="border-b border-line px-4 py-3 font-semibold">My documents</h2>
          <DocumentList employeeId={e.id} items={docs} canReview={false} />
        </section>
      </div>
    </>
  );
}
