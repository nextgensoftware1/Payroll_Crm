/** Fresh database from the real migrations, real restricted roles, and only
 *  the company basics: four departments, one Admin, one HR user. */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { migrate } from "../migrate.ts";

const SUPER = process.env.TEST_PG_SUPERUSER_URL ?? "postgresql://postgres:localtest@localhost:5432/postgres";
const ROOT = path.resolve(import.meta.dirname, "../..");
const withDb = (db: string, user?: string, pw?: string) => { const u = new URL(SUPER); u.pathname = `/${db}`; if (user) { u.username = user; u.password = pw ?? ""; } return u.toString(); };

export async function setupClean() {
  const db = `hr_mock_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const admin = postgres(SUPER, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database "${db}"`);
  for (const [role] of [["hr_api_login"], ["hr_worker_login"]] as const)
    if (!(await admin`select 1 from pg_roles where rolname = ${role}`).length) await admin.unsafe(`create role ${role} login noinherit password 'test'`);
  await admin.end();
  const owner = postgres(withDb(db), { max: 1, onnotice: () => {} });
  await owner.unsafe(readFileSync(path.join(ROOT, "db/local/0000_supabase_local_shim.sql"), "utf8"));
  await migrate(withDb(db), undefined, () => {});
  await owner.unsafe("grant hr_app to hr_api_login; grant hr_worker to hr_worker_login;");
  const U = { admin: "0a000000-0000-4000-8000-0000000000a1", hr: "0a000000-0000-4000-8000-0000000000b1" };
  await owner.unsafe(`
    insert into hr.user_role (auth_user_id, role, granted_by, grant_reason) values
      ('${U.admin}', 'admin', '00000000-0000-0000-0000-00000000a071', 'Company owner'),
      ('${U.hr}', 'hr', '${U.admin}', 'HR & Admin Officer');
    insert into hr.department (code, name) values ('OPS', 'Operations'), ('QA', 'Quality'), ('SALES', 'Sales'), ('ADMIN', 'Administration');`);
  Object.assign(process.env, {
    NODE_ENV: "test", DATABASE_URL: withDb(db, "hr_api_login", "test"), WORKER_DATABASE_URL: withDb(db, "hr_worker_login", "test"),
    DB_USES_TRANSACTION_POOLER: "false", NEXT_PUBLIC_SUPABASE_URL: "http://supabase.test", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "test-publishable-key",
    STORAGE_BACKEND: "local", LOCAL_STORAGE_DIR: mkdtempSync(path.join(tmpdir(), "hr-mock-")),
  });
  const { resetConfigForTests } = await import("../../src/server/config.ts"); resetConfigForTests();
  const { runAs } = await import("../../src/server/context.ts");
  const { LocalStorage } = await import("../../src/server/storage.ts");
  const storage = new LocalStorage(process.env.LOCAL_STORAGE_DIR!);
  const as = <T>(who: "admin" | "hr", fn: Parameters<typeof runAs<T>>[1]) => runAs<T>({ userId: U[who], email: `${who}@empire.test`, aal: "aal1" }, fn);
  const teardown = async (drop = true) => {
    const { closeDb } = await import("../../src/server/db.ts"); await closeDb(); await owner.end();
    if (drop) { const a = postgres(SUPER, { max: 1, onnotice: () => {} }); await a.unsafe(`drop database "${db}" with (force)`); await a.end(); }
  };
  return { as, storage, owner, teardown, U, db };
}
