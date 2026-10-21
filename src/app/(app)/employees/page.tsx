import type { Metadata } from "next";
import Link from "next/link";
import { Empty } from "@/components/Empty";
import { PageHeader } from "@/components/PageHeader";
import { StatusChip } from "@/components/StatusChip";
import { withSession } from "@/server/session";
import { reference } from "@/server/services/dashboard";
import { listEmployees } from "@/server/services/employees";
import { fmtDate, humanize } from "@/lib/format";

export const metadata: Metadata = { title: "Employees" };
type SP = Promise<{ q?: string; status?: string; department_id?: string; page?: string }>;

export default async function Employees({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const { staff, ref, data } = await withSession(async (c) => {
    const [ref, data] = await Promise.all([
      reference(c),
      listEmployees(c, { q: sp.q, status: sp.status, departmentId: sp.department_id || null, page, pageSize: 50 }),
    ]);
    return { staff: c.isStaff, ref, data };
  });
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const qs = (p: number) => new URLSearchParams({ ...(sp as Record<string, string>), page: String(p) }).toString();

  return (
    <>
      <PageHeader title="Employees" lede={staff ? "The register. Bank and identity numbers are never shown in lists." : "People on your team."}
        actions={staff ? <Link href="/employees/new" className="btn-primary">Add employee</Link> : null} />

      <form className="mb-4 flex flex-wrap items-end gap-3" role="search">
        <div className="min-w-56 flex-1">
          <label className="label" htmlFor="q">Search</label>
          <input id="q" name="q" defaultValue={sp.q} placeholder="Name, code or email" className="field" />
        </div>
        <div>
          <label className="label" htmlFor="status">Status</label>
          <select id="status" name="status" defaultValue={sp.status ?? ""} className="field">
            <option value="">Any</option><option value="active">Active</option>
            <option value="resigned">Resigned</option><option value="terminated">Terminated</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="department_id">Department</label>
          <select id="department_id" name="department_id" defaultValue={sp.department_id ?? ""} className="field">
            <option value="">All</option>
            {ref.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <button className="btn-quiet" type="submit">Filter</button>
      </form>

      {data.items.length === 0 ? (
        <Empty title="No employees match">Try a shorter search, or clear the filters.</Empty>
      ) : (
        <div className="panel overflow-x-auto">
          <table className="table min-w-[760px]">
            <thead><tr>
              <th scope="col">Employee</th><th scope="col">Role</th><th scope="col">Type</th><th scope="col">Joined</th>
              <th scope="col">Status</th>{staff ? <th scope="col">Documents</th> : null}
            </tr></thead>
            <tbody>
              {data.items.map((e) => (
                <tr key={e.id}>
                  <td><Link href={`/employees/${e.id}`} className="font-semibold hover:underline">{e.full_name}</Link>
                    <span className="block text-[13px] text-ink-3">{e.employee_code}</span></td>
                  <td>{e.job_title ?? "—"}<span className="block text-[13px] text-ink-3">{[e.department_name, e.team_name].filter(Boolean).join(", ")}</span></td>
                  <td>{humanize(e.employment_category)}</td>
                  <td>{fmtDate(e.joining_date)}</td>
                  <td><StatusChip status={e.status} /></td>
                  {staff ? (
                    <td>{e.documents && e.documents.required > 0 ? (
                      <span className={e.documents.complete < e.documents.required ? "font-semibold text-bad" : "text-ok"}>
                        {e.documents.complete} of {e.documents.required}
                      </span>) : <span className="text-ink-3">None required</span>}</td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 ? (
        <nav aria-label="Pages" className="mt-4 flex items-center gap-3 text-sm">
          {page > 1 ? <Link className="btn-quiet" href={`?${qs(page - 1)}`}>Previous</Link> : null}
          <span className="text-ink-2">Page {page} of {pages}, {data.total} people</span>
          {page < pages ? <Link className="btn-quiet" href={`?${qs(page + 1)}`}>Next</Link> : null}
        </nav>
      ) : null}
    </>
  );
}
