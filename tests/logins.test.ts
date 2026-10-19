/** Create login / reset password from the employee page (Admin only). */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { me } from "../src/server/services/dashboard.ts";
import { createEmployee } from "../src/server/services/employees.ts";
import { createLogin, resetPassword } from "../src/server/services/logins.ts";
import { DEPT, EMP, rejects, setup } from "./harness.ts";

class FakeAuth {
  users = new Map<string, { email: string; password: string; mustChange: boolean }>();
  deleted: string[] = [];
  async createUser(a: { email: string; password: string }) {
    if ([...this.users.values()].some((u) => u.email === a.email)) throw Object.assign(new Error("exists"), { status: 409 });
    const id = randomUUID(); this.users.set(id, { ...a, mustChange: true }); return { id };
  }
  async deleteUser(id: string) { this.users.delete(id); this.deleted.push(id); }
  async setTemporaryPassword(id: string, password: string) { const u = this.users.get(id)!; u.password = password; u.mustChange = true; }
  async clearMustChange(id: string) { this.users.get(id)!.mustChange = false; }
}

let h: Awaited<ReturnType<typeof setup>>;
let newEmp = "", hrEmp = "";
const auth = new FakeAuth();
const PW = "Temp-Pass-2026x";
before(async () => {
  h = await setup();
  newEmp = await h.as("hr", (c) => createEmployee(c, { employee_code: "EN-0100", full_name: "Kashif Mehmood", employment_category: "fixed_monthly",
    joining_date: "2026-08-17", department_id: DEPT, job_title: "Agent" }));
  hrEmp = await h.as("hr", (c) => createEmployee(c, { employee_code: "EN-0101", full_name: "Rabia Anwar", employment_category: "fixed_monthly",
    joining_date: "2026-09-01", department_id: DEPT, job_title: "HR Officer" }));
});
after(async () => { await h.teardown(); });

test("only Admin can create a login", async () => {
  await rejects(h.as("hr", (c) => createLogin(c, auth as never, { employee_id: newEmp, email: "kashif@empire.test", password: PW })), 403);
  assert.equal(auth.users.size, 0);
});

test("weak passwords are refused before anything is created", async () => {
  await rejects(h.as("admin", (c) => createLogin(c, auth as never, { employee_id: newEmp, email: "kashif@empire.test", password: "short1A" })), 422);
  await rejects(h.as("admin", (c) => createLogin(c, auth as never, { employee_id: newEmp, email: "kashif@empire.test", password: "alllowercase123" })), 422);
  assert.equal(auth.users.size, 0);
});

test("Admin creates a login: account linked, Employee role, must change password, audited", async () => {
  const r = await h.as("admin", (c) => createLogin(c, auth as never, { employee_id: newEmp, email: " Kashif@Empire.TEST ", password: PW }));
  assert.equal(r.email, "kashif@empire.test");
  const u = auth.users.get(r.userId)!;
  assert.deepEqual([u.email, u.mustChange], ["kashif@empire.test", true]);
  const [e] = await h.owner`select auth_user_id, work_email from hr.employee where id = ${newEmp}`;
  assert.deepEqual([e!.auth_user_id, e!.work_email], [r.userId, "kashif@empire.test"]);
  // the new person can sign in and sees only themselves
  const m = await h.runAs({ userId: r.userId, email: r.email, aal: "aal1" }, (c) => me(c));
  assert.deepEqual([m.roles, m.employeeId], [["employee"], newEmp]);
  const [a] = await h.owner`select count(*)::int as n from hr.audit_event where action = 'APP' and note like 'Created login kashif@empire.test%'`;
  assert.equal(a!.n, 1);
});

test("an HR login gets both roles", async () => {
  const r = await h.as("admin", (c) => createLogin(c, auth as never, { employee_id: hrEmp, email: "rabia@empire.test", password: PW, role: "hr" }));
  const roles = (await h.owner`select role::text as r from hr.user_role where auth_user_id = ${r.userId} order by r`).map((x) => x.r);
  assert.deepEqual(roles, ["employee", "hr"]);
});

test("an employee who already has a login is refused (use Reset password)", async () => {
  await rejects(h.as("admin", (c) => createLogin(c, auth as never, { employee_id: newEmp, email: "other@empire.test", password: PW })), 409, "already has a login");
  await rejects(h.as("admin", (c) => createLogin(c, auth as never, { employee_id: EMP.e1, email: "x@empire.test", password: PW })), 409);
});

test("if linking fails after Supabase created the account, the account is deleted (no orphan login)", async () => {
  const id3 = await h.as("hr", (c) => createEmployee(c, { employee_code: "EN-0102", full_name: "Temp Person", employment_category: "fixed_monthly",
    joining_date: "2026-09-01", department_id: DEPT, job_title: "Agent" }));
  // make the link step fail: the role grant for this auth id is blocked by a conflicting existing row
  const failing = { ...auth, createUser: async (a: { email: string; password: string }) => {
    const r = await auth.createUser(a); await h.owner`update hr.employee set auth_user_id = ${r.id} where id = ${EMP.e2}`.catch(() => {}); return r; },
    deleteUser: (id: string) => auth.deleteUser(id) };
  await assert.rejects(h.as("admin", (c) => createLogin(c, failing as never, { employee_id: id3, email: "temp@empire.test", password: PW })));
  assert.equal(auth.deleted.length, 1);
  assert.equal([...auth.users.values()].some((u) => u.email === "temp@empire.test"), false);
});

test("reset password: Admin only, sets a new temporary password, audited", async () => {
  await rejects(h.as("hr", (c) => resetPassword(c, auth as never, { employee_id: newEmp, password: PW })), 403);
  const uid = (await h.owner`select auth_user_id from hr.employee where id = ${newEmp}`)[0]!.auth_user_id as string;
  await auth.clearMustChange(uid);
  await h.as("admin", (c) => resetPassword(c, auth as never, { employee_id: newEmp, password: "Another-Temp-99" }));
  assert.deepEqual([auth.users.get(uid)!.password, auth.users.get(uid)!.mustChange], ["Another-Temp-99", true]);
  await rejects(h.as("admin", (c) => resetPassword(c, auth as never, { employee_id: newEmp, password: "weak" })), 422);
});
