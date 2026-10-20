# Empire Networks: HR & Attendance Control Centre

One Next.js 16 application (frontend **and** backend) on Supabase Postgres.

```
src/app/            pages (Server Components), Server Actions, route handlers
src/server/         the backend: plain TypeScript, no Next.js imports except session.ts
  context.ts          runs code as a person inside one RLS-scoped transaction
  db.ts               postgres.js; SET LOCAL ROLE + JWT claims per transaction
  services/           SQL + business rules (employees, documents, attendance, approvals)
  jobs/               background work: attendance import, probation/contract alerts
  zkteco/             device export parser (CSV, TSV, HTML-as-xls, legacy BIFF .xls)
  session.ts          the only bridge to Next.js + Supabase Auth
supabase/migrations/  16 SQL migrations (schema, RLS, insert-only grants)
db/                   SQL acceptance tests, setup scripts, local Supabase shim
tests/                node:test suites (no test framework dependency)
scripts/migrate.ts    migration runner (same tracking table as the Supabase CLI)
```

Payroll, payment and tax are **design-only and switched off**. A database CHECK
constraint makes it impossible to store those flags as "on", and no payroll or
payment pages or actions exist.

## How access control works

```
Browser -> proxy.ts -> Server Component / Server Action -> runAs(person) -> Postgres
           refresh     getClaims() verifies the JWT       SET LOCAL ROLE hr_app
           session                                         + JWT claims -> RLS decides which ROWS
```

The browser never talks to the database. Role checks in `services/` give clear
error messages; **Postgres row-level security is the real enforcement**, so a
bug in application code still can't return another employee's rows. The tests
prove this by querying tables directly as an employee.

## Background jobs without a separate server

Long imports never run inside a user's request:

1. After an upload, the Server Action calls `after()`, which starts parsing
   once the response has been sent.
2. Vercel Cron calls `/api/cron/attendance` every 5 minutes as a safety net,
   and `/api/cron/alerts` daily at 06:00 Pakistan time.

Both routes require `CRON_SECRET`, and jobs claim work with `FOR UPDATE SKIP
LOCKED`, so overlapping runs are safe. **Vercel Hobby runs crons only once a
day**; on Hobby the `after()` trigger does the work and the cron is a daily
retry. Pro allows the 5-minute schedule.

## Set up

1. **Create a Supabase project.**
   - Authentication > Providers: turn on email, turn off public sign-ups.
   - Settings > API > Exposed schemas: make sure `hr` is **not** listed.
   - Sign-in uses email and password; the app does not enroll or prompt for TOTP.
2. **Apply the migrations**, either way:
   - `MIGRATION_DATABASE_URL=<owner direct URL, port 5432> npm run db:migrate`, or
   - `supabase link --project-ref <ref> && supabase db push`, or
   - For a new project, open `db/export_supabase.sql` in the Supabase SQL Editor and run it once as the database owner. Regenerate it after migration changes with `npm run db:export`.

   The SQL export is a one-time schema setup, not a data transfer. Do not run it on a database where migrations have already been applied. It excludes login roles, initial Admin users, and development seed data; complete the following setup steps separately. The migration runner and Supabase CLI use the same tracking table.
3. **Create the login roles** (passwords are generated at run time and never committed):
   ```bash
   psql "$MIGRATION_DATABASE_URL" -v api_pw="$(openssl rand -base64 24)" \
        -v worker_pw="$(openssl rand -base64 24)" -f db/scripts/01_create_login_roles.sql
   ```
4. **Create the first two Admins.** Add them in Authentication > Users, then:
   ```bash
   psql "$MIGRATION_DATABASE_URL" -v admin1=<uuid> -v admin2=<uuid> \
        -v reason='Initial setup' -f db/scripts/02_bootstrap_first_admins.sql
   ```
5. *(Development only)* load reference data: `psql "$MIGRATION_DATABASE_URL" -f db/scripts/03_dev_seed.sql`
6. `cp .env.example .env.local`, fill in the values, then `npm ci && npm run dev`.

## Deploy to Vercel

Import the repo and set the variables from `.env.example`, except
`MIGRATION_DATABASE_URL`, which stays on your machine or in CI. `vercel.json`
registers the cron jobs. Use the **transaction pooler** URLs (port 6543) with
`DB_USES_TRANSACTION_POOLER=true`. Pick a Vercel region close to your Supabase
region (for Supabase `ap-south-1`, Vercel `bom1`).

## Tests

```bash
npm run typecheck && npm run build
TEST_PG_SUPERUSER_URL=postgresql://postgres:<pw>@localhost:5432/postgres npm test         # 44 tests
TEST_PG_SUPERUSER_URL=...                                                npm run test:pooler   # same, no prepared statements
```

Each test file builds a fresh database from the real migrations and runs as
the real restricted roles. The SQL suite (`db/tests/test_schema_security.sql`,
43 checks) runs against any migrated scratch database.

See `DECISIONS.md` for every assumed business rule.
