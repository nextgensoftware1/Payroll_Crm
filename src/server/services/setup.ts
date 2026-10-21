import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { suggestStartHour } from "../attendance/engine.ts";
import { type Ctx, requireRole } from "../context.ts";
import { AppError, notFound } from "../errors.ts";
import { headerMap, parseSalaryPkr } from "../zkteco/parser.ts";
import { approveNowIfAllowed } from "./approvals.ts";

/** "Set up these people" from an import: creates employees, a shift +
 *  Mon-Fri calendar per start hour, salary PROPOSALS and punch-mapping
 *  PROPOSALS. Salaries and mappings take effect only after a different
 *  Admin approves them (Approvals > Approve all). */

export const SHIFT_HOURS = [14, 15, 16, 17, 18, 19, 20, 21, 22] as const;
const label = (h: number) => `${((h + 11) % 12) + 1} ${h < 12 ? "AM" : "PM"}`;
export const shiftLabel = (h: number) => `${label(h)} to ${label((h + 9) % 24)}`;

// Sample data for the AUGUST demo file only (matches AUGUST_ATTENDANCE_with_shifts.xlsx).
const DEMO_SALARY: Record<string, number> = { "1": 52000, "3": 65000, "7": 77000, "8": 77000, "14": 86000, "21": 51000, "22": 59000,
  "27": 83000, "29": 84000, "40": 80000, "42": 71000, "45": 95000, "46": 81000, "47": 80000, "48": 91000 };

export type SetupRow = { enrollment_no: string; name_seen: string | null; rows: number; suggested_hour: number | null;
  suggested_salary: number | null; salary_source: "CSV" | "sample" | null; salary_conflict: boolean;
  existing_employee: string | null; employee_code: string | null; mapping_status: string | null;
  current_salary_pkr: number | null; has_pending_salary: boolean };

export async function setupCandidates(ctx: Ctx, batchId: string) {
  requireRole(ctx, "admin", "hr");
  const [b] = await ctx.tx<{ device_id: string; first_day: string | null }[]>`
    select b.device_id, (select min(device_local_ts)::date::text from hr.raw_import_row where batch_id = b.id and parse_status = 'ok') as first_day
    from hr.attendance_import_batch b where b.id = ${batchId}`;
  if (!b) throw notFound("Import batch");
  const [rows, maps, [header]] = await Promise.all([
    ctx.tx<{ enrollment_no: string; name_seen: string | null; ts: string[] }[]>`
    select r.enrollment_no, mode() within group (order by r.name_seen) as name_seen, array_agg(r.device_local_ts order by r.device_local_ts) as ts
    from hr.raw_import_row r where r.batch_id = ${batchId} and r.parse_status = 'ok' group by r.enrollment_no
    order by length(r.enrollment_no), r.enrollment_no`,
    ctx.tx<{ enrollment_no: string; status: string; employee: string; employee_code: string;
      current_salary_pkr: number | null; has_pending_salary: boolean }[]>`
    select pm.enrollment_no, pm.status::text as status, e.full_name as employee, e.employee_code,
           sal.current_salary_pkr,
           exists (select 1 from hr.compensation_plan cp where cp.employee_id = e.id and cp.status = 'proposed'
                   and cp.valid_during && daterange(${b.first_day}::date, null)) as has_pending_salary
    from hr.punch_mapping pm join hr.employee e on e.id = pm.employee_id
    left join lateral (
      select (cp.base_monthly_paisa / 100)::int as current_salary_pkr
      from hr.compensation_plan cp where cp.employee_id = e.id and cp.status = 'approved'
        and cp.valid_during @> ${b.first_day}::date
      order by lower(cp.valid_during) desc limit 1
    ) sal on true
    where pm.device_id = ${b.device_id} and pm.status in ('approved', 'proposed')`,
    ctx.tx<{ raw_cells: string[] }[]>`
    select raw_cells from hr.raw_import_row where batch_id = ${batchId} and row_number = 0`,
  ]);
  const salaryColumn = header ? headerMap(header.raw_cells).salary : undefined;
  const importedSalaryRows = salaryColumn === undefined ? [] : await ctx.tx<{ enrollment_no: string; salary_raw: string | null }[]>`
    select enrollment_no, raw_cells ->> ${salaryColumn}::int as salary_raw
    from hr.raw_import_row where batch_id = ${batchId} and parse_status = 'ok'`;
  const importedSalaries = new Map<string, { values: Set<number>; invalid: boolean }>();
  for (const row of importedSalaryRows) {
    const raw = row.salary_raw?.trim() ?? "";
    if (!raw) continue;
    const entry = importedSalaries.get(row.enrollment_no) ?? { values: new Set<number>(), invalid: false };
    const amount = parseSalaryPkr(raw);
    if (amount === null) entry.invalid = true;
    else entry.values.add(amount);
    importedSalaries.set(row.enrollment_no, entry);
  }
  return {
    deviceId: b.device_id,
    monthStart: b.first_day ? `${b.first_day.slice(0, 7)}-01` : null,
    people: rows.map((r): SetupRow => {
      const m = maps.find((x) => x.enrollment_no === r.enrollment_no);
      const imported = importedSalaries.get(r.enrollment_no);
      const salaryConflict = Boolean(imported && (imported.invalid || imported.values.size > 1));
      const importedSalary = imported && !salaryConflict && imported.values.size === 1 ? [...imported.values][0]! : null;
      const sampleSalary = salaryColumn === undefined ? DEMO_SALARY[r.enrollment_no] ?? null : null;
      return { enrollment_no: r.enrollment_no, name_seen: r.name_seen, rows: r.ts.length, suggested_hour: suggestStartHour(r.ts),
               suggested_salary: importedSalary ?? sampleSalary, salary_source: importedSalary !== null ? "CSV" : sampleSalary !== null ? "sample" : null,
               salary_conflict: salaryConflict, existing_employee: m?.employee ?? null, employee_code: m?.employee_code ?? null,
               mapping_status: m?.status ?? null, current_salary_pkr: m?.current_salary_pkr ?? null,
               has_pending_salary: m?.has_pending_salary ?? false };
    }),
  };
}

const Row = z.object({
  enrollment_no: z.string().min(1), include: z.boolean(),
  employee_code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,20}$/, "Employee codes use letters, numbers and dashes, like EN-0001."),
  full_name: z.string().trim().min(2, "Every included person needs a name."),
  shift_hour: z.coerce.number().int().min(0).max(23).nullable(),
  salary_pkr: z.coerce.number().int().min(0).max(10_000_000).nullable(),
});
export const SetupInput = z.object({ joining_date: z.iso.date("Choose the joining date."), department_id: z.guid().nullable(), rows: z.array(Row) });

type SalaryImportResult = { approved: number; proposed: number; unchanged: number; skipped: number; conflicts: string[] };

async function proposeSalary(ctx: Ctx, employeeId: string, employeeName: string, from: string, salaryPkr: number) {
  const [current] = await ctx.tx<{ salary_pkr: number }[]>`
    select (base_monthly_paisa / 100)::int as salary_pkr from hr.compensation_plan
    where employee_id = ${employeeId} and status = 'approved' and valid_during @> ${from}::date
    order by lower(valid_during) desc limit 1`;
  const [pending] = await ctx.tx<{ salary_pkr: number }[]>`
    select (base_monthly_paisa / 100)::int as salary_pkr from hr.compensation_plan
    where employee_id = ${employeeId} and status = 'proposed' and valid_during && daterange(${from}::date, null)
    order by lower(valid_during) desc limit 1`;
  if (pending) return pending.salary_pkr === salaryPkr ? "pending" as const : "conflict" as const;
  if (current?.salary_pkr === salaryPkr) return "unchanged" as const;

  const planId = randomUUID(), approvalId = randomUUID();
  await ctx.tx`insert into hr.approval_request (id, kind, subject_table, subject_id, subject_employee_id, required_role, reason)
               values (${approvalId}, 'compensation_change', 'compensation_plan', ${planId}, ${employeeId}, 'admin',
                       ${`Monthly salary PKR ${salaryPkr.toLocaleString("en-PK")} (from attendance import)`})`;
  await ctx.tx`insert into hr.compensation_plan (id, employee_id, pay_basis, base_monthly_paisa, valid_during, approval_request_id)
               values (${planId}, ${employeeId}, 'fixed_monthly', ${salaryPkr * 100}, daterange(${from}::date, null), ${approvalId})`;
  const approved = await approveNowIfAllowed(ctx, approvalId, "salary imported from attendance file");
  return approved ? "approved" as const : "proposed" as const;
}

/** Apply consistent salary values from an already-imported batch to its mapped employees. */
export async function syncBatchSalariesFromImport(ctx: Ctx, batchId: string): Promise<SalaryImportResult> {
  requireRole(ctx, "admin", "hr");
  const [batch] = await ctx.tx<{ status: string; promoted_punches: number | null }[]>`
    select status::text as status, promoted_punches from hr.attendance_import_batch where id = ${batchId}`;
  if (!batch) throw notFound("Import batch");
  if (batch.status !== "accepted" || batch.promoted_punches === null)
    throw new AppError(409, "batch_not_ready", "Salary import is available after the attendance batch has been accepted and processed.");

  const candidates = await setupCandidates(ctx, batchId);
  const [period] = await ctx.tx<{ from_date: string }[]>`
    select date_trunc('month', min(device_local_ts))::date::text as from_date
    from hr.raw_import_row where batch_id = ${batchId} and parse_status = 'ok'`;
  if (!period?.from_date) throw new AppError(422, "salary_period_missing", "The import has no valid attendance dates to apply salaries from.");

  const result: SalaryImportResult = { approved: 0, proposed: 0, unchanged: 0, skipped: 0, conflicts: [] };
  for (const person of candidates.people) {
    if (person.suggested_salary === null || person.salary_conflict) {
      result.skipped++;
      continue;
    }
    const [mapping] = await ctx.tx<{ employee_id: string; employee_name: string }[]>`
      select e.id as employee_id, e.full_name as employee_name
      from hr.punch_mapping pm join hr.employee e on e.id = pm.employee_id
      where pm.device_id = ${candidates.deviceId} and pm.enrollment_no = ${person.enrollment_no}
        and pm.status in ('approved', 'proposed')
      order by (pm.status = 'approved') desc, lower(pm.valid_during) desc limit 1`;
    if (!mapping) {
      result.skipped++;
      continue;
    }
    const outcome = await proposeSalary(ctx, mapping.employee_id, mapping.employee_name, period.from_date, person.suggested_salary);
    if (outcome === "conflict") result.conflicts.push(mapping.employee_name);
    else if (outcome === "approved") result.approved++;
    else if (outcome === "proposed" || outcome === "pending") result.proposed++;
    else result.unchanged++;
  }
  return result;
}

async function ensureShiftCalendar(ctx: Ctx, hour: number): Promise<string> {
  const code = `N${String(hour).padStart(2, "0")}`;
  const name = shiftLabel(hour);
  await ctx.tx`insert into hr.shift (code, name, start_local, end_local, unpaid_break_minutes, clock_in_window_before_minutes, clock_out_window_after_minutes)
               values (${code}, ${name}, make_time(${hour}, 0, 0), make_time(${(hour + 9) % 24}, 0, 0), 0, 180, 240)
               on conflict (code) do nothing`;
  const calCode = `MF-${code}`;
  await ctx.tx`insert into hr.work_calendar (code, name) values (${calCode}, ${`Mon-Fri, ${name}`}) on conflict (code) do nothing`;
  await ctx.tx`insert into hr.work_calendar_rule (calendar_id, iso_weekday, shift_id, valid_during)
               select c.id, d, case when d <= 5 then s.id end, daterange('2020-01-01', null)
               from hr.work_calendar c, hr.shift s, generate_series(1, 7) d
               where c.code = ${calCode} and s.code = ${code}
                 and not exists (select 1 from hr.work_calendar_rule r where r.calendar_id = c.id)`;
  const [c] = await ctx.tx<{ id: string }[]>`select id from hr.work_calendar where code = ${calCode}`;
  return c!.id;
}

export async function setupFromBatch(ctx: Ctx, batchId: string, input: z.input<typeof SetupInput>) {
  requireRole(ctx, "admin", "hr");
  const d = SetupInput.parse(input);
  const { deviceId } = await setupCandidates(ctx, batchId);
  const done = { employees: 0, salaries: 0, mappings: 0, skipped: 0 };
  let dept = d.department_id;
  if (!dept) {
    await ctx.tx`insert into hr.department (code, name) values ('OPS', 'Operations') on conflict (code) do nothing`;
    dept = (await ctx.tx<{ id: string }[]>`select id from hr.department where code = 'OPS'`)[0]!.id;
  }
  for (const r of d.rows.filter((x) => x.include)) {
    let [emp] = await ctx.tx<{ id: string }[]>`select id from hr.employee where employee_code = ${r.employee_code}`;
    if (!emp) {
      [emp] = await ctx.tx<{ id: string }[]>`
        insert into hr.employee (employee_code, full_name, employment_category, joining_date)
        values (${r.employee_code}, ${r.full_name}, 'fixed_monthly', ${d.joining_date}) returning id`;
      await ctx.tx`insert into hr.employee_assignment (employee_id, department_id, job_title, valid_during)
                   values (${emp!.id}, ${dept}, 'Agent', daterange(${d.joining_date}::date, null))`;
      await ctx.tx`insert into hr.employment_contract (series_id, revision_no, employee_id, contract_start, action, reason, effective_date)
                   values (${randomUUID()}, 1, ${emp!.id}, ${d.joining_date}, 'initial', 'Set up from attendance import', ${d.joining_date})`;
      done.employees++;
    } else done.skipped++;
    const id = emp!.id;
    if (r.shift_hour !== null) {
      const cal = await ensureShiftCalendar(ctx, r.shift_hour);
      const [has] = await ctx.tx`select 1 from hr.employee_calendar_assignment where employee_id = ${id}`;
      if (!has) await ctx.tx`insert into hr.employee_calendar_assignment (employee_id, calendar_id, valid_during)
                             values (${id}, ${cal}, daterange(${d.joining_date}::date, null))`;
    }
    if (r.salary_pkr !== null) {
      const outcome = await proposeSalary(ctx, id, r.full_name, d.joining_date, r.salary_pkr);
      if (outcome === "conflict")
        throw new AppError(409, "salary_change_pending", `A different salary change is already awaiting approval for ${r.full_name}. Resolve it before submitting another.`);
      if (outcome === "approved" || outcome === "proposed") done.salaries++;
    }
    const [mapped] = await ctx.tx`select 1 from hr.punch_mapping where device_id = ${deviceId} and enrollment_no = ${r.enrollment_no}
                                  and status in ('approved', 'proposed')`;
    if (!mapped) {
      const mappingId = randomUUID(), approvalId = randomUUID();
      await ctx.tx`insert into hr.approval_request (id, kind, subject_table, subject_id, subject_employee_id, required_role, reason)
                   values (${approvalId}, 'punch_mapping', 'punch_mapping', ${mappingId}, ${id}, 'admin', ${`Enrollment ${r.enrollment_no} seen in a device import`})`;
      await ctx.tx`insert into hr.punch_mapping (id, device_id, enrollment_no, employee_id, expected_name, valid_during, approval_request_id)
                   values (${mappingId}, ${deviceId}, ${r.enrollment_no}, ${id}, ${r.full_name}, daterange(${d.joining_date}::date, null), ${approvalId})`;
      await approveNowIfAllowed(ctx, approvalId, "enrollment link set up from import");
      done.mappings++;
    }
  }
  if (!done.employees && !done.salaries && !done.mappings && !done.skipped) throw new AppError(422, "nothing_selected", "Tick at least one person.");
  return done;
}
