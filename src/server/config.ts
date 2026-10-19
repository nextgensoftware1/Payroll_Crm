import "server-only";
import { z } from "zod";

const bool = (d: boolean) => z.enum(["true", "false"]).default(d ? "true" : "false").transform((v) => v === "true");

const Schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // App requests connect as hr_api_login, cron jobs as hr_worker_login.
  // Neither owns tables or has BYPASSRLS.
  DATABASE_URL: z.string().min(1),
  WORKER_DATABASE_URL: z.string().min(1).optional(),
  DB_USES_TRANSACTION_POOLER: bool(true), // Supabase pooler (6543) on Vercel: no prepared statements
  DB_POOL_MAX: z.coerce.number().int().min(1).max(20).default(3),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(10),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(10).optional(), // cron jobs only
  CRON_SECRET: z.string().min(32).optional(),
  STORAGE_BACKEND: z.enum(["supabase", "local"]).default("supabase"),
  LOCAL_STORAGE_DIR: z.string().default("./.storage"),
  REQUIRE_MFA_FOR_STAFF: bool(true),
  MAX_UPLOAD_BYTES: z.coerce.number().int().default(20 * 1024 * 1024),
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().default(60),
});

export type Config = z.infer<typeof Schema>;
let cached: Config | undefined;

/** Parsed on first use (not at import), so builds don't need secrets. */
export function config(): Config {
  if (cached) return cached;
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success)
    throw new Error(`Missing or invalid settings in .env.local: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}. Fix them and restart npm run dev.`);
  const c = parsed.data;
  if (c.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build") {
    if (c.STORAGE_BACKEND !== "supabase") throw new Error("production must use Supabase storage");
    if (!c.REQUIRE_MFA_FOR_STAFF) throw new Error("production requires MFA for HR/Admin");
  }
  cached = c;
  return c;
}

export function resetConfigForTests(): void {
  cached = undefined;
}
