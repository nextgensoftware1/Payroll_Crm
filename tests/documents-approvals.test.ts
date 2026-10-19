/** Documents (secure storage), onboarding, exit, config approval, and the
 *  database rules the app cannot bypass. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { runLifecycleAlerts } from "../src/server/jobs/lifecycle-alerts.ts";
import { decide, listApprovals, listConfig } from "../src/server/services/approvals.ts";
import { checklist, prepareDownload, review, uploadVersion } from "../src/server/services/documents.ts";
import { createEmployee, recordExit, timeline } from "../src/server/services/employees.ts";
import { CNIC, DEPT, EMP, rejects, setup } from "./harness.ts";

let h: Awaited<ReturnType<typeof setup>>;
let version = "", newEmp = "";
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
before(async () => { h = await setup(); });
after(async () => { await h.teardown(); });

test("employee uploads their own requested document", async () => {
  const v = await h.as("e1", (c) => uploadVersion(c, h.storage, { employeeId: EMP.e1, categoryId: CNIC, filename: "cnic.pdf", data: PDF }), "aal1");
  version = v.id;
  assert.equal(v.version_no, 1);
  const items = await h.as("e1", (c) => checklist(c, EMP.e1), "aal1");
  assert.equal(items[0]!.status, "uploaded");
});

test("employee cannot upload into someone else's record", async () => {
  await rejects(h.as("e1", (c) => uploadVersion(c, h.storage, { employeeId: EMP.e2, categoryId: CNIC, filename: "x.pdf", data: PDF }), "aal1"), 404);
});

test("a disguised file is rejected", async () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
  await rejects(h.as("e1", (c) => uploadVersion(c, h.storage, { employeeId: EMP.e1, categoryId: CNIC, filename: "cnic.pdf", data: png }), "aal1"), 422);
});

test("only the owner (and staff) can download; downloads are audited", async () => {
  await rejects(h.as("e2", (c) => prepareDownload(c, h.storage, version), "aal1"), 404);
  await rejects(h.as("manager", (c) => prepareDownload(c, h.storage, version), "aal1"), 404);
  const bytes = await h.as("e1", async (c) => (await prepareDownload(c, h.storage, version)).read(), "aal1");
  assert.deepEqual(bytes, PDF);
  const [n] = await h.owner`select count(*)::int as n from hr.audit_event where action = 'READ' and table_name = 'document_version'`;
  assert.ok(n!.n >= 1);
});

test("HR review moves the status; employees cannot review", async () => {
  await rejects(h.as("e1", (c) => review(c, version, { decision: "accepted", reason: "self" }), "aal1"), 403);
  await h.as("hr", (c) => review(c, version, { decision: "accepted", reason: "Matches original", expiry_date: "2030-01-01" }));
  const items = await h.as("hr", (c) => checklist(c, EMP.e1));
  assert.equal(items[0]!.status, "accepted");
  assert.equal(items[0]!.expiry_date, "2030-01-01");
});

test("HR onboards an employee: placement, manager, probation, requested documents", async () => {
  newEmp = await h.as("hr", (c) => createEmployee(c, {
    employee_code: "en-0048", full_name: "Aqsam", employment_category: "fixed_monthly", joining_date: "2026-08-01",
    department_id: DEPT, job_title: "Agent", manager_employee_id: EMP.manager, probation_end: "2026-11-01" }));
  const docs = await h.as("hr", (c) => checklist(c, newEmp));
  assert.equal(docs[0]!.status, "requested");
  const tl = await h.as("hr", (c) => timeline(c, newEmp));
  for (const k of ["joined", "position", "probation", "manager"]) assert.ok(tl.some((e) => e.kind === k), k);
});

test("invalid input gives a clear message", async () => {
  await assert.rejects(h.as("hr", (c) => createEmployee(c, { employee_code: "bad code", full_name: "X", employment_category: "fixed_monthly",
    joining_date: "2026-08-01", department_id: DEPT, job_title: "Agent" })), /letters, numbers and dashes/);
  await rejects(h.as("hr", (c) => createEmployee(c, { employee_code: "EN-0048", full_name: "Dup", employment_category: "fixed_monthly",
    joining_date: "2026-08-01", department_id: DEPT, job_title: "Agent" })), 409);
});

test("only admin records an exit; history survives", async () => {
  const input = { status: "resigned" as const, exit_date: "2026-09-30", exit_reason: "Moved city" };
  await rejects(h.as("hr", (c) => recordExit(c, newEmp, input)), 403);
  await h.as("admin", (c) => recordExit(c, newEmp, input));
  const [e] = await h.owner`select status from hr.employee where id = ${newEmp}`;
  assert.equal(e!.status, "resigned");
  const [a] = await h.owner`select count(*)::int as n from hr.employee_assignment where employee_id = ${newEmp}`;
  assert.equal(a!.n, 1);
  await rejects(h.as("admin", (c) => c.tx`delete from hr.employee where id = ${newEmp}`), 403);
});

test("strict mode: a changed rule waits for a second Admin, then replaces the old value without erasing it", async () => {
  const { changeConfig } = await import("../src/server/services/approvals.ts");
  const before = (await h.as("hr", (c) => listConfig(c))).filter((r) => r.key === "attendance.grace_minutes");
  assert.equal(before.find((r) => r.status === "approved")?.value, 10);       // activated by migration 0012
  const now = await h.as("hr", (c) => changeConfig(c, "attendance.grace_minutes", 15, "2026-11-01"));
  assert.equal(now, false);                                                   // not auto-approved in strict mode
  const pending = (await h.as("admin", (c) => listApprovals(c, { mine: true }))).find((a) => a.kind === "policy_config")!;
  await rejects(h.as("hr", (c) => decide(c, pending.id, { decision: "approved", reason: "mine" })), 409);
  await h.as("admin", (c) => decide(c, pending.id, { decision: "approved", reason: "Agreed" }));
  const rows = (await h.as("hr", (c) => listConfig(c))).filter((r) => r.key === "attendance.grace_minutes" && r.status === "approved");
  assert.deepEqual(rows.map((r) => [r.value, r.valid_from]).sort(), [[10, "2026-01-01"], [15, "2026-11-01"]]);
});

test("probation alert: created once, notifies admins, changes nothing", async () => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date());
  assert.equal(await runLifecycleAlerts(today), 1);   // Sibtain, 10 days out
  assert.equal(await runLifecycleAlerts(today), 0);   // idempotent
  const [n] = await h.owner`select count(*)::int as n from hr.notification where kind = 'lifecycle_alert'`;
  assert.equal(n!.n, 2); // two admins
  const [p] = await h.owner`select count(*)::int as n from hr.probation_period where employee_id = ${EMP.e2}`;
  assert.equal(p!.n, 1); // no auto-extension
});

test("payments, tax and the old late-deduction type stay impossible", async () => {
  await rejects(h.as("admin", (c) => c.tx`update hr.feature_flag set enabled = true`), 403);
  const [f] = await h.owner`select bool_or(enabled) as any_on from hr.feature_flag where key in ('payment_execution', 'tax_calculation', 'late_deduction')`;
  assert.equal(f!.any_on, false);
});
