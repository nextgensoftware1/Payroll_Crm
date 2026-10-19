/** Setup checker: tests exactly what the app does on every request.
 *    node --env-file=.env.local scripts/check-db.ts
 *  Prints PASS/FAIL per step with a plain-language fix. Never prints passwords. */
import postgres from "postgres";

const env = process.env;
let failed = false;
const ok = (m: string) => console.log(`  PASS  ${m}`);
const bad = (m: string, fix?: string) => { failed = true; console.log(`  FAIL  ${m}`); if (fix) console.log(`        Fix: ${fix}`); };

function hint(code: string | undefined, msg: string): string {
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "the host is wrong. Copy it from Supabase: Connect > Direct > Transaction pooler (it ends in pooler.supabase.com).";
  if (code === "ECONNREFUSED" || code === "ETIMEDOUT") return "cannot reach the host/port. Use the pooler host and port 6543 (5432 for migrations).";
  if (code === "28P01" || /password authentication failed/i.test(msg)) return "the password in the URL does not match the one set in the SQL Editor. Re-run the role SQL with the same password, or fix .env.local.";
  if (/tenant or user not found/i.test(msg)) return "the username must be ROLE.PROJECT_REF (e.g. hr_api_login.qlsaurtyspcwnlxyvtuh), and the role must exist: re-run the role SQL.";
  if (code === "42704") return "a role is missing. Run the migrations, then the role SQL.";
  if (code === "42501") return "the login role is not a member of its group role. Re-run the role SQL (the grant lines).";
  if (code === "3F000" || code === "42P01") return "migrations are not applied: node --env-file=.env.local scripts/migrate.ts";
  return "send this error line to your developer.";
}

const mask = (u: string) => { try { const x = new URL(u); x.password = x.password ? "****" : ""; return x.toString(); } catch { return "(not a valid URL)"; } };

console.log("\n1. Environment");
for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "DATABASE_URL", "WORKER_DATABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "CRON_SECRET"]) {
  const v = env[k];
  if (!v) bad(`${k} is missing`, `add it to .env.local`);
  else if (/CHANGE_ME|YOUR-POOLER-HOST|your-project-ref|xxxxxxxx|\[YOUR-PASSWORD\]/.test(v)) bad(`${k} still contains a placeholder`, "replace the placeholder text with the real value");
  else ok(`${k} is set`);
}
for (const k of ["DATABASE_URL", "WORKER_DATABASE_URL"]) {
  const v = env[k];
  if (!v) continue;
  try {
    const u = new URL(v);
    if (u.hostname.startsWith("db.")) bad(`${k} uses the direct db.* host`, "use the Transaction pooler host (…pooler.supabase.com), port 6543");
    if (u.port !== "6543") bad(`${k} uses port ${u.port || "(none)"}`, "the app should use the Transaction pooler, port 6543");
    if (env.DB_USES_TRANSACTION_POOLER === "false" && u.port === "6543") bad("DB_USES_TRANSACTION_POOLER=false with port 6543", "set DB_USES_TRANSACTION_POOLER=true");
  } catch { bad(`${k} is not a valid URL`, "check for spaces or special characters (@ : / ? # in the password break URLs)"); }
}

async function probe(label: string, url: string | undefined, role: "hr_app" | "hr_worker") {
  console.log(`\n${label}  ${url ? mask(url) : ""}`);
  if (!url) return bad("not set");
  const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 10, onnotice: () => {} });
  try {
    const [who] = await sql<{ u: string }[]>`select current_user as u`;
    ok(`connected as ${who!.u}`);
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`);
      ok(`can switch to ${role}`);
      if (role === "hr_app") {
        const [e] = await tx<{ n: number }[]>`select count(*)::int as n from hr.employee`;
        ok(`can query the hr schema (row-level security active: ${e!.n} rows visible without a signed-in user, as expected)`);
      }
      if (role === "hr_worker") {
        const [a] = await tx<{ n: number }[]>`select count(*)::int as n from hr.user_role where role = 'admin' and revoked_at is null`;
        if (a!.n >= 2) ok(`${a!.n} admins exist`); else bad(`${a!.n} admin(s) found; need 2`, "run the admin bootstrap SQL with both UIDs");
      }
    });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    bad(`${err.code ? `[${err.code}] ` : ""}${err.message}`, hint(err.code, err.message ?? ""));
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

await probe("2. App connection (DATABASE_URL)", env.DATABASE_URL, "hr_app");
await probe("3. Background-job connection (WORKER_DATABASE_URL)", env.WORKER_DATABASE_URL, "hr_worker");

console.log("\n4. Supabase");
if (env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
  try {
    const r = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/bucket`, {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } });
    if (!r.ok) bad(`storage API answered ${r.status}`, "check SUPABASE_SERVICE_ROLE_KEY (use the current secret key)");
    else {
      const ids = ((await r.json()) as { id: string }[]).map((b) => b.id);
      const need = ["employee-documents", "attendance-imports", "payment-evidence", "payslips"];
      const missing = need.filter((b) => !ids.includes(b));
      if (missing.length) bad(`missing storage buckets: ${missing.join(", ")}`, "re-run the migrations");
      else ok("all 4 private storage buckets exist");
    }
  } catch (e) { bad(`cannot reach Supabase: ${(e as Error).message}`); }
}

console.log(failed ? "\nSome checks failed. Fix the first FAIL above, then run this again.\n" : "\nAll checks passed. Restart npm run dev.\n");
process.exit(failed ? 1 : 0);
