/** Integration harness for node:test.
 *  Builds a FRESH database with the real migrations, connects as
 *  hr_api_login / hr_worker_login (the same restricted roles production
 *  uses), and runs services as real principals. Nothing is mocked except
 *  Supabase Storage (local, write-once) and Supabase Auth (we pass the
 *  verified identity directly, as session.ts would after getClaims()). */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { migrate } from "../scripts/migrate.ts";

const SUPER = process.env.TEST_PG_SUPERUSER_URL ?? "postgresql://postgres:localtest@localhost:5432/postgres";
const ROOT = path.resolve(import.meta.dirname, "..");
const withDb = (url: string, db: string, user?: string, pw?: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  if (user) { u.username = user; u.password = pw ?? ""; }
  return u.toString();
};

export const U = Object.fromEntries(Object.entries({ admin: "a1", admin2: "a2", hr: "b1", manager: "c1", e1: "e1", e2: "e2" })
  .map(([k, v]) => [k, `00000000-0000-0000-0000-0000000000${v}`])) as Record<"admin" | "admin2" | "hr" | "manager" | "e1" | "e2", string>;
export const EMP = { manager: "10000000-0000-0000-0000-0000000000c1", e1: "10000000-0000-0000-0000-0000000000e1", e2: "10000000-0000-0000-0000-0000000000e2" };
export const DEPT = "20000000-0000-0000-0000-000000000001";
export const DEVICE = "50000000-0000-0000-0000-000000000001";
export const CNIC = "30000000-0000-0000-0000-000000000001";
export const SAMPLE = new Uint8Array(readFileSync(path.join(ROOT, "tests/fixtures/AUGUST_ATTANADANCE.xls")));

const SEED = `
insert into hr.user_role (auth_user_id, role, granted_by, grant_reason) values
 ('${U.admin}','admin','${U.admin2}','seed'), ('${U.admin2}','admin','${U.admin}','seed'), ('${U.hr}','hr','${U.admin}','seed'),
 ('${U.manager}','manager','${U.admin}','seed'), ('${U.manager}','employee','${U.admin}','seed'),
 ('${U.e1}','employee','${U.admin}','seed'), ('${U.e2}','employee','${U.admin}','seed');
insert into hr.department (id, code, name) values ('${DEPT}', 'OPS', 'Operations');
insert into hr.employee (id, employee_code, full_name, employment_category, joining_date, auth_user_id) values
 ('${EMP.manager}','EN-0003','Muhammad Shoaib','fixed_monthly','2025-01-01','${U.manager}'),
 ('${EMP.e1}','EN-0001','Moon','fixed_monthly','2025-03-01','${U.e1}'),
 ('${EMP.e2}','EN-0027','Sibtain','fixed_monthly','2025-06-01','${U.e2}');
insert into hr.employee_assignment (employee_id, department_id, job_title, valid_during)
 select id, '${DEPT}', 'Agent', daterange('2025-01-01', null) from hr.employee;
insert into hr.manager_assignment (employee_id, manager_employee_id, valid_during)
 values ('${EMP.e1}', '${EMP.manager}', daterange('2025-01-01', null));
insert into hr.probation_period (series_id, revision_no, employee_id, probation_start, probation_end, action, reason, effective_date)
 values (gen_random_uuid(), 1, '${EMP.e2}', '2025-06-01', (now() at time zone 'Asia/Karachi')::date + 10, 'initial', 'seed', '2025-06-01');
insert into hr.device (id, name, location_code, datetime_format, status_label_map)
 values ('${DEVICE}', 'Main entrance', '101', 'M/D/YYYY h:mm:ss AM', '{"C/In":"in","C/Out":"out"}');
insert into hr.document_category (id, code, name, sensitivity) values ('${CNIC}', 'CNIC', 'CNIC copy', 'highly_sensitive');
insert into hr.approval_request (id, kind, subject_table, subject_id, requested_by, reason, status)
 values ('40000000-0000-0000-0000-000000000099', 'document_requirement', 'document_requirement',
         '41000000-0000-0000-0000-000000000099', '${U.hr}', 'seed', 'approved');
insert into hr.document_requirement (id, category_id, employment_category, is_required, legal_basis_note, valid_during, status, approval_request_id)
 values ('41000000-0000-0000-0000-000000000099', '${CNIC}', 'fixed_monthly', true, 'Identity verification for payroll',
         daterange('2025-01-01', null), 'approved', '40000000-0000-0000-0000-000000000099');
insert into hr.employee_document (employee_id, category_id, status, requested_at)
 select id, '${CNIC}', 'requested', now() from hr.employee;`;

export type Who = keyof typeof U;

export async function setup() {
  const db = `hr_test_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const admin = postgres(SUPER, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database "${db}"`);
  for (const [role, group] of [["hr_api_login", "hr_app"], ["hr_worker_login", "hr_worker"]] as const)
    if (!(await admin`select 1 from pg_roles where rolname = ${role}`).length)
      await admin.unsafe(`create role ${role} login noinherit password 'test'`);
  await admin.end();

  const owner = postgres(withDb(SUPER, db), { max: 1, onnotice: () => {} });
  await owner.unsafe(readFileSync(path.join(ROOT, "db/local/0000_supabase_local_shim.sql"), "utf8"));
  await migrate(withDb(SUPER, db), undefined, () => {});
  await owner.unsafe("grant hr_app to hr_api_login; grant hr_worker to hr_worker_login;");
  await owner.unsafe(SEED);
  // Most suites test the strict two-person rules; auto-mode.test.ts switches this back on.
  await owner.unsafe("update hr.feature_flag set enabled = false where key = 'single_admin_mode'");

  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: withDb(SUPER, db, "hr_api_login", "test"),
    WORKER_DATABASE_URL: withDb(SUPER, db, "hr_worker_login", "test"),
    DB_USES_TRANSACTION_POOLER: process.env.TEST_POOLER_MODE === "true" ? "true" : "false",
    NEXT_PUBLIC_SUPABASE_URL: "http://supabase.test",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
    STORAGE_BACKEND: "local",
    LOCAL_STORAGE_DIR: mkdtempSync(path.join(tmpdir(), "hr-storage-")),
    REQUIRE_MFA_FOR_STAFF: "true",
  });
  const { resetConfigForTests } = await import("../src/server/config.ts");
  resetConfigForTests();
  const { runAs } = await import("../src/server/context.ts");
  const { LocalStorage } = await import("../src/server/storage.ts");
  const storage = new LocalStorage(process.env.LOCAL_STORAGE_DIR!);

  /** Run a service as a person. Staff default to MFA-verified (aal2). */
  const as = <T>(who: Who, fn: Parameters<typeof runAs<T>>[1], aal = "aal2") =>
    runAs<T>({ userId: U[who], email: `${who}@empire.test`, aal }, fn);

  const teardown = async () => {
    const { closeDb } = await import("../src/server/db.ts");
    await closeDb();
    await owner.end();
    const a = postgres(SUPER, { max: 1, onnotice: () => {} });
    await a.unsafe(`drop database "${db}" with (force)`);
    await a.end();
  };
  const runAsStranger = () => runAs({ userId: randomUUID(), email: null, aal: "aal2" }, async () => null);
  return { as, storage, owner, teardown, runAsStranger, runAs };
}

/** Assert a promise rejects with an AppError of a given status (and optional message part). */
export async function rejects(p: Promise<unknown>, status: number, includes?: string) {
  const { toAppError } = await import("../src/server/errors.ts");
  try { await p; } catch (e) {
    const err = toAppError(e);
    if (err.status !== status) throw new Error(`expected ${status}, got ${err.status}: ${err.message}`);
    if (includes && !err.message.includes(includes)) throw new Error(`expected message containing "${includes}", got "${err.message}"`);
    return err;
  }
  throw new Error(`expected rejection with ${status}, but it succeeded`);
}
