import "server-only";
import { computeMonth, type MonthResult, type Policy, type Shift } from "../attendance/engine.ts";
import { type Ctx, requireRole } from "../context.ts";
import { AppError } from "../errors.ts";
import { configValue } from "./dashboard.ts";

/** Monthly attendance + calculated deductions. Two queries (people, punches)
 *  then the pure engine in memory: fast even for hundreds of staff. */

export type PolicyInfo = Policy & { approved: boolean; pending: string[] };
export type ReportPerson = {
  employee_id: string; employee_code: string; full_name: string; department: string | null; shift: Shift | null;
  joining_date: string; exit_date: string | null;
  workdays: number[]; salary_paisa: number | null; salary_status: string | null; result: MonthResult;
};

const KEYS = {
  graceMinutes: "attendance.grace_minutes", latePercentOfDay: "attendance.late_penalty_percent_of_day",
  workingDaysDivisor: "payroll.working_days_divisor", absenceDays: "attendance.absence_penalty_days",
} as const;
const DEFAULTS: Policy = { graceMinutes: 10, latePercentOfDay: 4, workingDaysDivisor: 22, absenceDays: 1 };

export async function loadPolicy(ctx: Ctx, on: string): Promise<PolicyInfo> {
  const out = { ...DEFAULTS } as Policy;
  const pending: string[] = [];
  for (const [k, key] of Object.entries(KEYS) as [keyof Policy, string][]) {
    const v = await configValue(ctx.tx, key, on);
    if (v) out[k] = Number(v.value);
    if (!v || v.status !== "approved") pending.push(key);
  }
  return { ...out, approved: pending.length === 0, pending };
}

export const nowKarachi = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 19);

export async function monthReport(ctx: Ctx, f: { month: string; employeeId?: string | null; departmentId?: string | null; shiftCode?: string | null }) {
  requireRole(ctx, "admin", "hr");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(f.month)) throw new AppError(422, "bad_month", "Choose a month.");
  const start = `${f.month}-01`;
  const [y, m] = f.month.split("-").map(Number) as [number, number];
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const policy = await loadPolicy(ctx, start);

  const people = await ctx.tx<{
    employee_id: string; employee_code: string; full_name: string; department: string | null; department_id: string | null;
    shift_code: string | null; shift_name: string | null; start_min: number | null; duration_min: number | null; before_min: number | null;
    workdays: number[] | null; salary_paisa: string | null; salary_status: string | null; joining_date: string; exit_date: string | null;
  }[]>`
    select e.id as employee_id, e.employee_code, e.full_name, d.name as department, a.department_id,
           sh.code as shift_code, sh.name as shift_name,
           (extract(hour from sh.start_local) * 60 + extract(minute from sh.start_local))::int as start_min,
           (sh.scheduled_minutes + sh.unpaid_break_minutes)::int as duration_min, sh.clock_in_window_before_minutes as before_min,
           wk.days as workdays, cp.base_monthly_paisa as salary_paisa, cp.status::text as salary_status, e.joining_date, e.exit_date
    from hr.employee e
    left join lateral (select ea.department_id from hr.employee_assignment ea where ea.employee_id = e.id
                       and ea.valid_during && daterange(${start}::date, ${end}::date, '[]') order by lower(ea.valid_during) desc limit 1) a on true
    left join hr.department d on d.id = a.department_id
    left join lateral (select eca.calendar_id from hr.employee_calendar_assignment eca where eca.employee_id = e.id
                       and eca.valid_during && daterange(${start}::date, ${end}::date, '[]') order by lower(eca.valid_during) desc limit 1) ca on true
    left join lateral (select array_agg(r.iso_weekday order by r.iso_weekday) filter (where r.shift_id is not null) as days,
                              (array_agg(r.shift_id) filter (where r.shift_id is not null))[1] as shift_id
                       from hr.work_calendar_rule r where r.calendar_id = ca.calendar_id
                       and r.valid_during && daterange(${start}::date, ${end}::date, '[]')) wk on true
    left join hr.shift sh on sh.id = wk.shift_id
    left join lateral (select c.base_monthly_paisa, c.status from hr.compensation_plan c where c.employee_id = e.id
                       and c.valid_during && daterange(${start}::date, ${end}::date, '[]') and c.status in ('approved', 'proposed')
                       order by c.status = 'approved' desc, c.created_at desc limit 1) cp on true
    where (e.status = 'active' or e.exit_date >= ${start}::date) and e.joining_date <= ${end}::date
      and (${f.employeeId ?? null}::uuid is null or e.id = ${f.employeeId ?? null}::uuid)
      and (${f.departmentId ?? null}::uuid is null or a.department_id = ${f.departmentId ?? null}::uuid)
      and (${f.shiftCode ?? null}::text is null or sh.code = ${f.shiftCode ?? null}::text)
    order by e.employee_code`;
  if (!people.length) return { policy, people: [] as ReportPerson[], month: f.month };

  const ids = people.map((p) => p.employee_id);
  // punches: generous window (previous evening to the morning after), engine assigns exact business dates
  const punches = await ctx.tx<{ employee_id: string; ts: string }[]>`
    select pm.employee_id, p.device_local_ts as ts
    from hr.raw_punch p
    join hr.punch_mapping pm on pm.device_id = p.device_id and pm.enrollment_no = p.enrollment_no
         and pm.status = 'approved' and pm.valid_during @> p.device_local_ts::date
    where p.device_local_ts >= ${start}::timestamp - interval '1 day' and p.device_local_ts < ${end}::timestamp + interval '2 days'
      and pm.employee_id = any(${ids}::uuid[])
      and not exists (select 1 from hr.attendance_correction c where c.target_raw_punch_id = p.id
                      and c.kind = 'disregard_punch' and hr.is_approved(c.approval_request_id))
    order by p.device_local_ts`;
  const leave = await ctx.tx<{ employee_id: string; d: string }[]>`
    select lr.employee_id, gs::date::text as d from hr.leave_request lr
    cross join generate_series(greatest(lr.start_date, ${start}::date), least(lr.end_date, ${end}::date), interval '1 day') gs
    where lr.employee_id = any(${ids}::uuid[]) and hr.is_approved(lr.approval_request_id)`;
  const holidays = await ctx.tx<{ d: string; employee_id: string | null }[]>`
    select h.holiday_date::text as d, he.employee_id from hr.holiday h left join hr.holiday_employee he on he.holiday_id = h.id
    where h.status = 'approved' and h.holiday_date between ${start}::date and ${end}::date`;

  const byEmp = new Map<string, string[]>();
  for (const p of punches) byEmp.set(p.employee_id, [...(byEmp.get(p.employee_id) ?? []), p.ts]);
  const now = nowKarachi();
  return {
    policy, month: f.month,
    people: people.map((p): ReportPerson => {
      const shift: Shift | null = p.shift_code && p.start_min !== null
        ? { code: p.shift_code, name: p.shift_name ?? p.shift_code, startMin: p.start_min, durationMin: p.duration_min ?? 540, windowBeforeMin: p.before_min ?? 180 }
        : null;
      const salary = p.salary_paisa === null ? null : Number(p.salary_paisa);
      return {
        employee_id: p.employee_id, employee_code: p.employee_code, full_name: p.full_name, department: p.department,
        joining_date: p.joining_date, exit_date: p.exit_date,
        shift, workdays: p.workdays ?? [], salary_paisa: salary, salary_status: p.salary_status,
        result: computeMonth({
          month: f.month, now, shift, workdays: p.workdays ?? [], punches: byEmp.get(p.employee_id) ?? [], monthlyPaisa: salary, policy,
          employedFrom: p.joining_date, employedTo: p.exit_date,
          leave: new Set(leave.filter((l) => l.employee_id === p.employee_id).map((l) => l.d)),
          holidays: new Set(holidays.filter((h) => !h.employee_id || h.employee_id === p.employee_id).map((h) => h.d)),
        }),
      };
    }),
  };
}

export async function shiftOptions(ctx: Ctx) {
  return ctx.tx<{ code: string; name: string }[]>`select code, name from hr.shift where is_active order by start_local`;
}

export async function latestPunchMonth(ctx: Ctx): Promise<string> {
  const [r] = await ctx.tx<{ m: string | null }[]>`select to_char(max(device_local_ts), 'YYYY-MM') as m from hr.raw_punch`;
  return r?.m ?? nowKarachi().slice(0, 7);
}

/** Months that have recorded punches (newest first), for month pickers. */
export async function monthsWithPunches(ctx: Ctx): Promise<string[]> {
  const rows = await ctx.tx<{ m: string }[]>`
    select distinct to_char(device_local_ts, 'YYYY-MM') as m from hr.raw_punch order by m desc limit 36`;
  return rows.map((r) => r.m);
}
