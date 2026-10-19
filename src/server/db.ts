import "server-only";
import postgres from "postgres";
import { config } from "./config.ts";

/** Database access with row-level security.
 *
 * Every unit of work is ONE transaction that first runs
 *   SET LOCAL ROLE hr_app | hr_worker
 *   set_config('request.jwt.claims', <verified claims>, true)
 * so Postgres policies see the real caller. SET LOCAL scopes both to the
 * transaction: safe with a pool and with Supabase's transaction pooler. */

export type Tx = postgres.TransactionSql<Record<string, never>>;
export type Claims = { sub: string; role: "authenticated"; aal: string; email: string | null };
type Kind = "app" | "worker";

// Keep wire formats as strings: dates stay 'YYYY-MM-DD', timestamps become
// ISO strings, so values serialise cleanly into React components.
const keep = (oid: number) => ({ to: oid, from: [oid], serialize: (x: string) => x, parse: (x: string) => x });
const iso = (oid: number) => ({
  to: oid, from: [oid], serialize: (x: string) => x,
  parse: (x: string) => new Date(x.replace(" ", "T").replace(/\+00$/, "Z")).toISOString(),
});
const naive = (oid: number) => ({ to: oid, from: [oid], serialize: (x: string) => x, parse: (x: string) => x.replace(" ", "T") });

const g = globalThis as unknown as { __hrSql?: Partial<Record<Kind, postgres.Sql>> };
g.__hrSql ??= {};

function client(kind: Kind): postgres.Sql {
  const existing = g.__hrSql![kind];
  if (existing) return existing;
  const c = config();
  const url = kind === "app" ? c.DATABASE_URL : c.WORKER_DATABASE_URL;
  if (!url) throw new Error(`${kind === "app" ? "DATABASE_URL" : "WORKER_DATABASE_URL"} is not set`);
  const sql = postgres(url, {
    max: c.DB_POOL_MAX,
    prepare: !c.DB_USES_TRANSACTION_POOLER,
    idle_timeout: 20,
    connect_timeout: 10,
    connection: { application_name: kind === "app" ? "empire-hr-web" : "empire-hr-jobs", TimeZone: "UTC" },
    types: { date: keep(1082), timestamptz: iso(1184), timestamp: naive(1114) } as never,
    onnotice: () => {},
  });
  g.__hrSql![kind] = sql;
  return sql;
}

export async function withRls<T>(kind: Kind, claims: Claims | null, requestId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (await client(kind).begin(async (tx) => {
    await tx.unsafe(kind === "app" ? "SET LOCAL ROLE hr_app" : "SET LOCAL ROLE hr_worker"); // fixed literals only
    await tx`select set_config('request.jwt.claims', ${claims ? JSON.stringify(claims) : ""}, true),
                    set_config('hr.request_id', ${requestId}, true)`;
    return fn(tx as unknown as Tx);
  })) as T;
}

export async function closeDb(): Promise<void> {
  await Promise.all(Object.values(g.__hrSql!).map((s) => s?.end({ timeout: 5 })));
  g.__hrSql = {};
}
