/** Applies supabase/migrations/*.sql in order, each in its own transaction.
 *
 * Uses the SAME tracking table as the Supabase CLI
 * (supabase_migrations.schema_migrations), so `supabase db push` and this
 * script never re-apply each other's work. Use this for Neon, CI and tests;
 * use the Supabase CLI for Supabase if you prefer.
 *
 *   MIGRATION_DATABASE_URL=postgresql://postgres:...@host:5432/postgres node scripts/migrate.ts
 * Needs the OWNER connection (direct, port 5432), never the app login. */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

export async function migrate(url: string, dir = path.join(import.meta.dirname, "..", "supabase", "migrations"), log = console.log) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`create schema if not exists supabase_migrations`;
    await sql`create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text)`;
    const done = new Set((await sql<{ version: string }[]>`select version from supabase_migrations.schema_migrations`).map((r) => r.version));
    const files = readdirSync(dir).filter((f) => /^\d{14}_.+\.sql$/.test(f)).sort();
    for (const f of files) {
      const [version, ...rest] = f.replace(/\.sql$/, "").split("_");
      if (done.has(version!)) continue;
      const body = readFileSync(path.join(dir, f), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into supabase_migrations.schema_migrations (version, statements, name) values (${version!}, ${[body]}, ${rest.join("_")})`;
      });
      log(`applied ${f}`);
    }
    return files.length;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) { console.error("Set MIGRATION_DATABASE_URL (owner connection, port 5432)"); process.exit(1); }
  migrate(url).then((n) => console.log(`migrations up to date (${n} files)`), (e) => { console.error(e.message); process.exit(1); });
}
