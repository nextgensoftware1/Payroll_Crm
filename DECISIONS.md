# Decisions: assumed, and changed with the move to Next.js only

## Business rules (assumed until you confirm)

| # | Question | Current default | Where |
|---|----------|-----------------|-------|
| 1 | Shift pairing windows (how early a clock-in counts, how late a clock-out belongs to last night) | **No default.** HR sets them per shift. The dev seed has a PLACEHOLDER night shift. | `hr.shift` columns |
| 2 | Overtime "authorised in advance" cutoff | Before the scheduled shift **ends** | `hr.set_overtime_in_advance()` |
| 3 | Who accepts an import batch | HR or Admin | `services/attendance.ts` |
| 4 | Enrollment number to employee mapping | Needs a **different** Admin's approval | approval kind `punch_mapping` |
| 5 | Fractional eligible days (half-days) | Allowed, 3 decimals | `payroll_line.eligible_days` |
| 6 | Leave unit | Minutes | `leave_transaction.minutes` |
| 7 | Rounding | Paisa, half-up (60,000 / 26 x 17 = 39,230.77). Whole-rupee net pay: undecided | payroll engine (later step) |
| 8 | Exited employees | Login and roles revoked at exit; history kept | `services/employees.ts recordExit` |
| 9 | Alert follow-ups after the 15-day alert | Only the initial alert exists; follow-up timing undecided | `jobs/lifecycle-alerts.ts` |
| 10 | Employee self-upload of documents | Allowed **after HR requests** the document | `services/documents.ts` + RLS |
| 11 | Near-duplicate threshold | 60 s, **proposed** (Admin approves in-app) | `policy_config` |
| 12 | Grace period | 10 min, **proposed** | `policy_config` |
| 13 | HR reviewing a document HR uploaded | Allowed (no second reviewer) | `hr.on_document_review()` |
| 14 | Retention | 6 years, **proposed**; verify with a tax adviser | `retention_policy` |

## Pay rules decided by the owner (2026-10-19)

| Rule | Value | Setting key |
|------|-------|-------------|
| Grace period | late only if MORE than 10 minutes after shift start (10:00 is fine, 10:01 is late) | `attendance.grace_minutes` |
| Late deduction | 4% of that day's salary per late day | `attendance.late_penalty_percent_of_day` |
| A day's salary | monthly salary / 22 (August 2026 has 21 weekdays; 22 is used as decided) | `payroll.working_days_divisor` |
| Absence | 1 full day's salary per absent working day | `attendance.absence_penalty_days` |
| Working days | Monday to Friday (from the August data: no Saturday shifts) | shift calendars `MF-N16`..`MF-N22` |
| Single punch on a day | "Needs review": NO deduction until HR resolves it | engine rule |
| Rest-day work, approved leave, approved holidays | never deducted | engine rule |

These are seeded as PROPOSED and must be approved (Settings, then a second Admin).
Reports show deductions as CALCULATED amounts. Nothing is cut from pay: payroll
execution is still locked off by a database constraint and needs a reviewed migration.

**Legal check recommended before applying cuts to real pay:** wage laws in
Pakistan limit fines and deductions (e.g. caps on fines per wage period, and
fines only for acts listed in an approved notice). Absence deductions
proportional to the days missed are generally treated differently from fines.
This is not legal advice; confirm with your adviser.

**Still locked**
- The old "one hour's salary" late deduction type: replaced by the 4% rule above, still unapprovable.
- Overtime multipliers and tax slabs: not seeded.

## Architecture changes from the FastAPI version (please review)

| Change | Why | Trade-off |
|--------|-----|-----------|
| No FastAPI; backend is `src/server` in Next.js | Your decision: one codebase | Same RLS model; the database is still the enforcement point |
| Alembic replaced by SQL migrations + `scripts/migrate.ts` | No Python in the stack | Shares the Supabase CLI tracking table; forward-only, as before |
| Background worker replaced by `after()` + Vercel Cron | No long-running server on Vercel | Hobby plan: cron once a day (after() still processes immediately) |
| `SUPABASE_SERVICE_ROLE_KEY` now lives in the web app's server environment | Jobs run inside the same deployment | Server-only (no `NEXT_PUBLIC_`), used only in `serviceStorage()` for job file reads. A separate worker would isolate it further. |
| Own BIFF `.xls` reader instead of a spreadsheet library | npm's SheetJS (0.18.5) has known CVEs; patched builds are off-npm | Reads cell text only (all that exports contain); verified cell-for-cell against xlrd on your file |
| `.xlsx` uploads refused with advice to export CSV | ZKTeco exports CSV/XLS/TXT; brief says prefer CSV | Re-add later if a device can only write .xlsx |
| `node:test` instead of a test framework | vitest's dependency tree hit an npm resolver bug; Node 22 runs TS natively | Zero test dependencies |

## Single-admin mode (owner decision 2026-10-19), ON

The owner asked to remove approval steps: "just upload files and all records show".

| What happens automatically | Recorded as |
|---|---|
| Every approval request (salary, enrollment link, setting) is approved at once | an approval decision by the **System** actor (`…a070`), reason "Auto-approved (single-admin mode)" |
| Each uploaded file is accepted after it is read; review flags are kept | flags marked `accepted_as_is`, batch reviewed by System |
| Enrollment numbers seen for the first time become employees | name from the file, shift from their punches (3+ days), created by the import actor (`…a071`) |
| Changing a salary or a rule | the old value stays for earlier months; the new one starts from the chosen month/date |

**Trade-off:** one Admin can now change salaries and attendance alone. Every step
is still in the audit log, and nothing is deleted.

**Still locked in this mode:** payroll and payment execution, the old late-deduction
type, raw-punch immutability, duplicate protection, employees seeing others' data.

**Turn two-person approval back on** (owner, SQL Editor):
`update hr.feature_flag set enabled = false where key = 'single_admin_mode';`

## Payroll ON (owner decision 2026-10-19)

`payroll_execution` is ON (migration 0013): calculate a month, approve and **lock** it
(insert-only snapshot), issue payslips, reopen with a reason (the locked version is kept).

| Item | Rule |
|---|---|
| Gross | monthly salary; joined/left mid-month = a day's salary (÷22) × working days employed |
| Cuts | late days × 4% of a day + absent days × 1 day; never more than gross; "needs review" days never cut |
| Net | gross − cuts. **Tax is not calculated** (rates not verified); payslips say "pay before tax" |
| Approval | Admin approves the exact figures (line count, total, hash). Single-admin mode: the preparer may approve; otherwise a different Admin must |

**Still pinned OFF by the database:** `payment_execution` (the app never sends or records
money; pay from the bank), `tax_calculation`, `late_deduction` (the old one-hour type).

## Fixes found by the realistic-company simulation (2026-10-19)

- **Auto-created employees** got the 1st of the month as joining date; now their first punch date (migration 0014).
- **Gross pay had two sources**: Reports used the full salary, Payroll the prorated amount for mid-month joiners. The attendance engine is now the single source; Overview, Reports, Payroll and payslips show the same gross, deductions and net.
- **Late minutes** are rounded up (10 min 1 s shows as 11 min), so a late day never shows "10 min".

## UI redesign (2026-10-19), real data

Applied the Empire HR reference design to the real app (not a mock prototype):
navy sidebar, teal actions, Inter (self-hosted), light/dark themes, Recharts dashboards,
split login with the night-city image (optimised 2 MB PNG -> 141 KB WebP, JPEG fallback).
Every chart and KPI reads the same engine as Reports and Payroll.

Not taken from the mock-prototype brief, on purpose:
- **Role switcher**: roles come from the signed-in account; a switcher would let anyone view as Admin.
- **"Remember me" / demo notice**: Supabase sessions are already persistent; there is no demo mode on real data.

Fixed along the way: public images (.webp) were redirected to /login by the proxy;
red "danger" buttons were never styled (class name built dynamically, so Tailwind skipped it);
added a real password reset ("Forgot password?" -> email link -> new password).
