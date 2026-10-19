/** Acceptance test 9: an employee cannot reach another employee's records
 *  by changing a URL (id) or a filter. Enforced by Postgres RLS. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { checklist } from "../src/server/services/documents.ts";
import { getEmployee, listEmployees, timeline } from "../src/server/services/employees.ts";
import { listBatches } from "../src/server/services/attendance.ts";
import { me, summary } from "../src/server/services/dashboard.ts";
import { EMP, rejects, setup } from "./harness.ts";

let h: Awaited<ReturnType<typeof setup>>;
before(async () => { h = await setup(); });
after(async () => { await h.teardown(); });

test("staff need MFA; employees do not", async () => {
  const e = await rejects(h.as("hr", (c) => listEmployees(c, {}), "aal1"), 403);
  assert.equal(e.code, "mfa_required");
  const m = await h.as("e1", (c) => me(c), "aal1");
  assert.deepEqual(m.roles, ["employee"]);
  assert.equal(m.employeeId, EMP.e1);
});

test("unknown login has no access", async () => {
  const e = await rejects(h.runAsStranger(), 403);
  assert.equal(e.code, "no_access");
});

test("employee sees only self, without document completeness", async () => {
  const page = await h.as("e1", (c) => listEmployees(c, {}), "aal1");
  assert.equal(page.total, 1);
  assert.equal(page.items[0]!.id, EMP.e1);
  assert.equal(page.items[0]!.documents, null);
});

test("employee cannot reach another employee by id", async () => {
  await rejects(h.as("e1", (c) => getEmployee(c, EMP.e2), "aal1"), 404);
  await rejects(h.as("e1", (c) => timeline(c, EMP.e2), "aal1"), 404);
  await rejects(h.as("e1", (c) => checklist(c, EMP.e2), "aal1"), 404);
});

test("employee cannot reach another employee by search filter", async () => {
  const page = await h.as("e1", (c) => listEmployees(c, { q: "Sibtain" }), "aal1");
  assert.equal(page.total, 0);
});

test("employee is blocked from staff areas", async () => {
  await rejects(h.as("e1", (c) => listBatches(c), "aal1"), 403);
  await rejects(h.as("e1", (c) => summary(c), "aal1"), 403);
});

test("RLS holds even if the app-level check is bypassed", async () => {
  // query the table directly as e1: the database itself returns zero rows
  const rows = await h.as("e1", (c) => c.tx`select id from hr.employee where id = ${EMP.e2}`, "aal1");
  assert.equal(rows.length, 0);
  const docs = await h.as("e1", (c) => c.tx`select id from hr.employee_document where employee_id = ${EMP.e2}`, "aal1");
  assert.equal(docs.length, 0);
});

test("manager sees team but never documents", async () => {
  const page = await h.as("manager", (c) => listEmployees(c, {}), "aal1");
  const ids = new Set(page.items.map((i) => i.id));
  assert.ok(ids.has(EMP.manager) && ids.has(EMP.e1) && !ids.has(EMP.e2));
  await rejects(h.as("manager", (c) => getEmployee(c, EMP.e2), "aal1"), 404);
  await rejects(h.as("manager", (c) => checklist(c, EMP.e1), "aal1"), 404);
});

test("HR sees all with document completeness", async () => {
  const page = await h.as("hr", (c) => listEmployees(c, {}));
  assert.ok(page.total >= 3);
  assert.ok(page.items.every((i) => i.documents?.required === 1));
});

test("dashboard shows probation ending within 15 days", async () => {
  const d = await h.as("admin", (c) => summary(c));
  assert.ok(d.expiring.some((x) => x.employee_id === EMP.e2 && x.kind === "probation_end" && x.days_remaining === 10));
});
