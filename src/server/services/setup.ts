import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { suggestStartHour } from "../attendance/engine.ts";
import { type Ctx, requireRole } from "../context.ts";
import { AppError, notFound } from "../errors.ts";
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
  demo_salary: number | null; existing_employee: string | null; mapping_status: string | null };

export async function setupCandidates(ctx: Ctx, batchId: string) {
  requireRole(ctx, "admin", "hr");
  const [b] = await ctx.tx<{ device_id: string; first_day: string | null }[]>`
    select b.device_id, (select min(device_local_ts)::date::text from hr.raw_import_row where batch_id = b.id and parse_status = 'ok') as first_day
    from hr.attendance_import_batch b where b.id = ${batchId}`;
  if (!b) throw notFound("Import batch");
  const rows = await ctx.tx<{ enrollment_no: string; name_seen: string | null; ts: string[] }[]>`
    select r.enrollment_no, mode() within group (order by r.name_seen) as name_seen, array_agg(r.device_local_ts order by r.device_local_ts) as ts
    from hr.raw_import_row r where r.batch_id = ${batchId} and r.parse_status = 'ok' group by r.enrollment_no
    order by length(r.enrollment_no), r.enrollment_no`;
  const maps = await ctx.tx<{ enrollment_no: string; status: string; employee: string }[]>`
    select pm.enrollment_no, pm.status::text as status, e.full_name as employee from hr.punch_mapping pm join hr.employee e on e.id = pm.employee_id
    where pm.device_id = ${b.device_id} and pm.status in ('approved', 'proposed')`;
  return {
    deviceId: b.device_id,
    monthStart: b.first_day ? `${b.first_day.slice(0, 7)}-01` : null,
    people: rows.map((r): SetupRow => {
      const m = maps.find((x) => x.enrollment_no === r.enrollment_no);
      return { enrollment_no: r.enrollment_no, name_seen: r.name_seen, rows: r.ts.length, suggested_hour: suggestStartHour(r.ts),
               demo_salary: DEMO_SALARY[r.enrollment_no] ?? null, existing_employee: m?.employee ?? null, mapping_status: m?.status ?? null };
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
      const [has] = await ctx.tx`select 1 from hr.compensation_plan where employee_id = ${id} and status in ('approved', 'proposed')`;
      if (!has) {
        const planId = randomUUID(), approvalId = randomUUID();
        await ctx.tx`insert into hr.approval_request (id, kind, subject_table, subject_id, subject_employee_id, required_role, reason)
                     values (${approvalId}, 'compensation_change', 'compensation_plan', ${planId}, ${id}, 'admin',
                             ${`Monthly salary PKR ${r.salary_pkr.toLocaleString("en-PK")} (set up from import)`})`;
        await ctx.tx`insert into hr.compensation_plan (id, employee_id, pay_basis, base_monthly_paisa, valid_during, approval_request_id)
                     values (${planId}, ${id}, 'fixed_monthly', ${r.salary_pkr * 100}, daterange(${d.joining_date}::date, null), ${approvalId})`;
        await approveNowIfAllowed(ctx, approvalId, "salary set up from import");
        done.salaries++;
      }
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
