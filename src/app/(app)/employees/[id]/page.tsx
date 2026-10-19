import type { Metadata } from "next";
import { ActionForm } from "@/components/ActionForm";
import { DocumentList } from "@/components/DocumentList";
import { PageHeader } from "@/components/PageHeader";
import { StatusChip } from "@/components/StatusChip";
import { withSession } from "@/server/session";
import { checklist } from "@/server/services/documents";
import { getEmployee, timeline as getTimeline } from "@/server/services/employees";
import { fmtDate, fmtDateTime, humanize } from "@/lib/format";
import { linkAccount, recordExit } from "../actions";
import { saveSalary } from "../salary-actions";
import { createLoginAction, resetPasswordAction } from "../login-actions";
import { PasswordField } from "@/components/PasswordField";
import { salaryHistory } from "@/server/services/salary";
import { pkr } from "@/lib/format";

export const metadata: Metadata = { title: "Employee" };

export default async function EmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { e, timeline, docs, staff, isAdmin, salaries } = await withSession(async (c) => ({
    e: await getEmployee(c, id),
    timeline: await getTimeline(c, id),
    docs: c.isStaff || c.employeeId === id ? await checklist(c, id) : null,
    staff: c.isStaff,
    isAdmin: c.isAdmin,
    salaries: c.isStaff ? await salaryHistory(c, id) : [],
  }));
  const facts: [string, React.ReactNode][] = [
    ["Job title", e.job_title ?? "—"], ["Department", [e.department_name, e.team_name].filter(Boolean).join(", ") || "—"],
    ["Manager", e.manager_name ?? "—"], ["Employment type", humanize(e.employment_category)],
    ["Joined", fmtDate(e.joining_date)],
    ["Probation", e.probation ? `${fmtDate(e.probation.start)} to ${fmtDate(e.probation.end)}${e.probation.revision_no > 1 ? ` (revision ${e.probation.revision_no})` : ""}` : "None"],
    ["Contract", e.contract ? `${fmtDate(e.contract.start)} to ${e.contract.end ? fmtDate(e.contract.end) : "open-ended"}` : "—"],
    ["Work email", e.work_email ?? "—"], ["Phone", e.phone ?? "—"],
    ["Sign-in", e.has_login ? "Linked" : "Not linked"],
  ];
  if (e.exit_date) facts.push(["Left", `${fmtDate(e.exit_date)}: ${e.exit_reason}`]);

  return (
    <>
      <PageHeader title={e.full_name} lede={<span className="flex items-center gap-2">{e.employee_code} <StatusChip status={e.status} /></span>} />
      <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        <div className="space-y-6">
          <section className="panel">
            <h2 className="border-b border-line px-4 py-3 font-semibold">Details</h2>
            <dl className="grid gap-x-6 gap-y-3 p-4 sm:grid-cols-2">
              {facts.map(([k, v]) => <div key={k}><dt className="text-[13px] text-ink-3">{k}</dt><dd className="text-[15px]">{v}</dd></div>)}
            </dl>
          </section>
          {staff ? (
            <section id="salary" className="panel">
              <h2 className="border-b border-line px-4 py-3 font-semibold">Monthly salary</h2>
              <div className="grid gap-4 p-4 md:grid-cols-2">
                <div>
                  {salaries.length ? (
                    <ul className="space-y-1 text-[14.5px]">{salaries.map((x, i) => (
                      <li key={i} className={i ? "text-ink-3" : ""}><span className={i ? "" : "text-[20px] font-bold"}>PKR {pkr(Number(x.salary_paisa))}</span>
                        <span className="block text-[13px]">from {fmtDate(x.from)}{x.to ? ` to ${fmtDate(x.to)}` : ""}{x.status === "proposed" ? ", waiting for approval" : ""}</span></li>))}</ul>
                  ) : <p className="text-[14.5px] text-warn">No salary set. Reports show attendance only.</p>}
                </div>
                <ActionForm action={saveSalary} submit={salaries.length ? "Change salary" : "Set salary"} className="space-y-2">
                  <input type="hidden" name="employee_id" value={id} />
                  <div className="grid grid-cols-2 gap-2">
                    <div><label className="label" htmlFor="salary_pkr">PKR per month</label>
                      <input id="salary_pkr" name="salary_pkr" className="field text-right" inputMode="numeric" required placeholder="52,000" /></div>
                    <div><label className="label" htmlFor="from_month">From month</label>
                      <input id="from_month" name="from_month" type="month" className="field" required defaultValue={new Date().toISOString().slice(0, 7)} /></div>
                  </div>
                  <p className="text-[13px] text-ink-3">Earlier months keep the old salary.</p>
                </ActionForm>
              </div>
            </section>
          ) : null}
          {docs ? (
            <section className="panel">
              <h2 className="border-b border-line px-4 py-3 font-semibold">Documents</h2>
              <DocumentList employeeId={id} items={docs} canReview={staff} />
              <p className="border-t border-line px-4 py-2.5 text-[13px] text-ink-3">A missing document is shown at each payroll preparation. It never holds back pay.</p>
            </section>
          ) : null}
        </div>
        <div className="space-y-6">
          <section className="panel">
            <h2 className="border-b border-line px-4 py-3 font-semibold">Timeline</h2>
            <ol className="relative space-y-4 p-4 before:absolute before:top-5 before:bottom-5 before:left-[21px] before:w-px before:bg-line">
              {timeline.map((t, i) => (
                <li key={i} className="relative pl-6">
                  <span aria-hidden className="absolute top-1.5 left-0 size-2.5 rounded-full border-2 border-accent bg-surface" />
                  <p className="text-[14.5px] font-medium">{t.title}</p>
                  <p className="text-[13px] text-ink-3">{fmtDateTime(t.occurred_at)}</p>
                </li>
              ))}
            </ol>
          </section>
          {isAdmin && e.status === "active" ? (
            <section className="panel space-y-5 p-4">
              <h2 className="font-semibold">Admin actions</h2>
              {!e.has_login ? (
                <div className="space-y-3">
                  <h3 className="font-semibold">Create login</h3>
                  <ActionForm action={createLoginAction} submit="Create login" pending="Creating…">
                    <input type="hidden" name="employee_id" value={id} />
                    <div><label className="label" htmlFor="login_email">Work email (their username)</label>
                      <input id="login_email" name="email" type="email" className="field" defaultValue={e.work_email ?? ""} placeholder="name@empirenetworks.com" required /></div>
                    <PasswordField id="login_password" name="password" label="Temporary password" />
                    <div><label className="label" htmlFor="login_role">Access</label>
                      <select id="login_role" name="role" className="field" defaultValue="employee">
                        <option value="employee">Employee: own records and payslips only</option>
                        <option value="manager">Manager: also their team&apos;s attendance</option>
                        <option value="hr">HR: everything except Admin actions (needs authenticator app)</option>
                      </select></div>
                  </ActionForm>
                  <details className="text-[13.5px]">
                    <summary className="cursor-pointer text-ink-2">Link an existing login instead</summary>
                    <ActionForm action={linkAccount} submit="Link login" variant="quiet" className="mt-2 space-y-2">
                      <input type="hidden" name="employee_id" value={id} />
                      <label className="label" htmlFor="auth_user_id">Supabase user ID</label>
                      <input id="auth_user_id" name="auth_user_id" className="field font-mono text-sm" placeholder="00000000-0000-…" required />
                    </ActionForm>
                  </details>
                </div>
              ) : (
                <div className="space-y-2">
                  <h3 className="font-semibold">Reset password</h3>
                  <p className="text-[13px] text-ink-2">Sets a new temporary password; they must choose their own at next sign-in.</p>
                  <ActionForm action={resetPasswordAction} submit="Reset password" variant="quiet" pending="Resetting…">
                    <input type="hidden" name="employee_id" value={id} />
                    <PasswordField id="reset_password" name="password" label="New temporary password" />
                  </ActionForm>
                </div>
              )}
              <div className="space-y-2 border-t border-line pt-4">
                <h3 className="font-semibold text-bad">Record exit</h3>
              <ActionForm action={recordExit} submit="Record exit" variant="danger" pending="Recording…">
                <input type="hidden" name="employee_id" value={id} />
                <div className="grid grid-cols-2 gap-2">
                  <div><label className="label" htmlFor="status">Reason type</label>
                    <select id="status" name="status" className="field"><option value="resigned">Resigned</option><option value="terminated">Terminated</option></select></div>
                  <div><label className="label" htmlFor="exit_date">Last day</label>
                    <input id="exit_date" name="exit_date" type="date" className="field" required /></div>
                </div>
                <label className="label" htmlFor="exit_reason">Details</label>
                <textarea id="exit_reason" name="exit_reason" className="field" rows={2} minLength={5} required />
                <p className="text-[13px] text-ink-3">Disables sign-in and revokes roles. Records and history are kept.</p>
              </ActionForm>
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}
