/** User-facing errors. Trigger messages come from our own hr.* functions
 *  and explain which rule blocked the action, so they are safe to show. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}, cause?: unknown) {
    super(message, { cause });
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const STATES: Record<string, [number, string]> = {
  "42501": [403, "not_permitted"], P0001: [409, "rule_violation"], "23505": [409, "already_exists"],
  "23P01": [409, "overlapping_period"], "23514": [422, "invalid_value"], "23503": [422, "unknown_reference"],
  "23502": [422, "missing_value"], "22P02": [422, "invalid_format"], "40001": [409, "retry"],
};

export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const z = e as { name?: string; issues?: { message: string }[] };
  if (z?.name === "ZodError" && z.issues?.length) return new AppError(422, "invalid_input", z.issues[0]!.message);
  const pg = e as { name?: string; code?: string; message?: string };
  const hit = pg?.name === "PostgresError" && pg.code ? STATES[pg.code] : undefined;
  if (hit) {
    const [status, code] = hit;
    let msg = pg.message ?? "Not allowed.";
    if (pg.code === "42501" && msg.startsWith("permission denied")) msg = "Your role does not allow this action.";
    if (pg.code === "23505") msg = "That already exists.";
    return new AppError(status, code, msg);
  }
  // Production hides internals; development shows the real cause so setup
  // problems (wrong DATABASE_URL, migrations not applied...) are obvious.
  const raw = e as { code?: string; message?: string };
  const detail = `${raw?.code ? `[${raw.code}] ` : ""}${raw?.message ?? String(e)}`;
  const hint = setupHint(raw?.code, raw?.message ?? "");
  return new AppError(500, "unexpected", process.env.NODE_ENV === "production"
    ? "Something went wrong. Try again, and tell IT if it keeps happening."
    : `Unexpected error (details shown in development only): ${detail}${hint ? ` | Likely fix: ${hint}` : ""}`, {}, e);
}

/** Plain-language hints for the setup mistakes that cause most first-run errors. */
export function setupHint(code: string | undefined, message: string): string | null {
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "the database host in DATABASE_URL is wrong (still the .env.example placeholder?).";
  if (code === "ECONNREFUSED" || code === "ETIMEDOUT") return "the database is not reachable on that host/port. Check DATABASE_URL and your network.";
  if (code === "28P01" || /password authentication failed/i.test(message)) return "wrong password in DATABASE_URL, or the login role was never created (db/scripts/01_create_login_roles.sql).";
  if (/tenant or user not found/i.test(message)) return "with Supabase's pooler the username must be hr_api_login.<project-ref>, and the role must exist.";
  if (code === "42P01" || code === "3F000" || /schema "hr" does not exist/i.test(message)) return "migrations have not been applied. Run: npm run db:migrate";
  if (code === "42704" && /role "hr_(app|worker)"/i.test(message)) return "migrations have not been applied (they create hr_app/hr_worker). Run: npm run db:migrate";
  if (code === "3D000") return "the database name in DATABASE_URL does not exist (Supabase uses 'postgres').";
  if (code === "42501" && /set role/i.test(message)) return "the login role is not a member of hr_app/hr_worker. Re-run db/scripts/01_create_login_roles.sql.";
  if (/DATABASE_URL|WORKER_DATABASE_URL/.test(message) && /not set/.test(message)) return "add the variable to .env.local and restart npm run dev.";
  return null;
}

export const notFound = (what = "Record") => new AppError(404, "not_found", `${what} not found.`);
