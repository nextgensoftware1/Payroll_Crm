/** Realistic mock company, run THROUGH THE REAL APP CODE.
 *
 *  1. builds 15 employees (profiles below) with effective-dated salaries
 *  2. generates ZKTeco-style device exports for June, July (partial + full)
 *     and August 2026 from per-person behaviour, deterministically (seeded)
 *  3. uploads them through the real import pipeline, runs and locks payroll
 *     with the real payroll service, reopens July for a late-approved leave
 *  4. exports everything the APP calculated to fixture.json
 *  Every number in the fixture comes from the app, never typed by hand.
 *
 *  node --conditions=react-server scripts/mock/simulate.ts <outDir>       */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const OUT = path.resolve(process.argv[2] ?? "mock-out");
mkdirSync(path.join(OUT, "device-exports"), { recursive: true });

// ------------------------------------------------------------ deterministic RNG
function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

// ------------------------------------------------------------ the company
type P = {
  no: number; name: string; title: string; dept: "Operations" | "Quality" | "Sales" | "Administration"; shift: number | null;
  joined: string; salary: [string, number][]; lead?: number; lateP: number; missP: number; arrive: number; arriveSd: number;
  leave: number; probationEnd?: string; contractEnd?: string; verify: "FP" | "FACE";
};
const PEOPLE: P[] = [
  { no: 1, name: "Ayesha Khan", title: "Customer Support Agent", dept: "Operations", shift: 17, joined: "2024-03-04", salary: [["2024-03", 52000]], lead: 2, lateP: 0.10, missP: 0.03, arrive: -9, arriveSd: 5, leave: 10, verify: "FP" },
  { no: 2, name: "Bilal Ahmed", title: "Team Lead", dept: "Operations", shift: 17, joined: "2022-09-12", salary: [["2022-09", 85000], ["2026-08", 88000]], lateP: 0.02, missP: 0.01, arrive: -22, arriveSd: 6, leave: 12, verify: "FACE" },
  { no: 3, name: "Hamza Raza", title: "Customer Support Agent", dept: "Operations", shift: 17, joined: "2025-11-03", salary: [["2025-11", 48000]], lead: 2, lateP: 0.24, missP: 0.06, arrive: -3, arriveSd: 7, leave: 8, verify: "FP" },
  { no: 4, name: "Sana Iqbal", title: "Senior Support Agent", dept: "Operations", shift: 17, joined: "2023-06-19", salary: [["2023-06", 60000], ["2026-07", 63000]], lead: 2, lateP: 0.08, missP: 0.02, arrive: -11, arriveSd: 5, leave: 12, verify: "FACE" },
  { no: 5, name: "Usman Tariq", title: "Customer Support Agent", dept: "Operations", shift: 17, joined: "2024-10-07", salary: [["2024-10", 50000]], lead: 2, lateP: 0.12, missP: 0.04, arrive: -6, arriveSd: 6, leave: 10, verify: "FP" },
  { no: 6, name: "Fatima Noor", title: "Customer Support Agent", dept: "Operations", shift: 18, joined: "2025-01-13", salary: [["2025-01", 51000]], lead: 12, lateP: 0.20, missP: 0.03, arrive: -4, arriveSd: 7, leave: 9, verify: "FP" },
  { no: 7, name: "Ali Hassan", title: "Senior Support Agent", dept: "Operations", shift: 18, joined: "2023-02-06", salary: [["2023-02", 66000]], lead: 12, lateP: 0.09, missP: 0.02, arrive: -12, arriveSd: 5, leave: 12, verify: "FACE" },
  { no: 8, name: "Zainab Malik", title: "Quality Analyst", dept: "Quality", shift: 17, joined: "2023-08-21", salary: [["2023-08", 72000]], lateP: 0.03, missP: 0.01, arrive: -15, arriveSd: 4, leave: 14, verify: "FACE" },
  { no: 9, name: "Omar Farooq", title: "Sales Executive", dept: "Sales", shift: 18, joined: "2024-05-27", salary: [["2024-05", 58000]], lateP: 0.11, missP: 0.03, arrive: -7, arriveSd: 6, leave: 6, contractEnd: "2026-10-31", verify: "FP" },
  { no: 10, name: "Hira Shah", title: "HR & Admin Officer", dept: "Administration", shift: 16, joined: "2022-04-11", salary: [["2022-04", 75000]], lateP: 0.02, missP: 0.01, arrive: -14, arriveSd: 4, leave: 15, verify: "FACE" },
  { no: 11, name: "Saad Qureshi", title: "IT Support Engineer", dept: "Administration", shift: 16, joined: "2023-11-20", salary: [["2023-11", 78000]], lateP: 0.04, missP: 0.02, arrive: -10, arriveSd: 5, leave: 9, verify: "FP" },
  { no: 12, name: "Mariam Javed", title: "Team Lead", dept: "Operations", shift: 18, joined: "2021-07-05", salary: [["2021-07", 92000]], lateP: 0.01, missP: 0.01, arrive: -25, arriveSd: 6, leave: 14, verify: "FACE" },
  { no: 13, name: "Danish Ali", title: "Customer Support Agent (trainee)", dept: "Operations", shift: 17, joined: "2026-07-13", salary: [["2026-07", 45000]], lead: 2, lateP: 0.15, missP: 0.05, arrive: -5, arriveSd: 7, leave: 7, probationEnd: "2026-10-12", verify: "FP" },
  { no: 14, name: "Noor Fatima", title: "Sales Executive", dept: "Sales", shift: null, joined: "2025-03-10", salary: [["2025-03", 55000]], lateP: 0.10, missP: 0.03, arrive: -8, arriveSd: 8, leave: 8, verify: "FP" },
  // first appears in the August export: created automatically by the import, no salary yet
  { no: 15, name: "Kashif Mehmood", title: "Customer Support Agent", dept: "Operations", shift: 17, joined: "2026-08-17", salary: [], lateP: 0.12, missP: 0.03, arrive: -8, arriveSd: 6, leave: 0, probationEnd: "2026-11-16", verify: "FP" },
];
const NOOR_ACTUAL_START = 17; // Noor works ~5 PM but no shift is configured for her in the system

// Scripted, realistic exceptions (on top of each person's random behaviour)
const ABSENT: Record<number, string[]> = {
  3: ["2026-06-23", "2026-07-08", "2026-08-12", "2026-08-24"], 5: ["2026-08-20"], 6: ["2026-06-11"],
  1: ["2026-07-28"], 9: ["2026-06-29"], 13: ["2026-08-07"],
};
const LEAVE: { no: number; from: string; to: string; type: "ANNUAL" | "SICK"; approvedAfterJulyLock?: boolean }[] = [
  { no: 6, from: "2026-07-20", to: "2026-07-21", type: "ANNUAL", approvedAfterJulyLock: true }, // drives the July v2 story
  { no: 7, from: "2026-08-05", to: "2026-08-05", type: "SICK" },
  { no: 10, from: "2026-06-15", to: "2026-06-17", type: "ANNUAL" },
];
const HOLIDAYS = [{ date: "2026-08-14", name: "Independence Day" }];
const REST_DAY_WORK = [{ no: 9, date: "2026-08-22", in: "18:02", out: "23:41" }]; // Saturday campaign
const BOUNDARY = [{ no: 4, date: "2026-08-06", lateBySec: 600 }, { no: 7, date: "2026-08-06", lateBySec: 601 }]; // exactly 10:00 vs 10:01

// ------------------------------------------------------------ punch generation
type Punch = { no: number; ts: string; label: "C/In" | "C/Out"; verify: string };
const dayList = (from: string, to: string) => { const out: string[] = []; for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10)); return out; };
const wd = (d: string) => ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
const at = (d: string, minutes: number, sec: number) => new Date(Date.parse(`${d}T00:00:00Z`) + (minutes * 60 + sec) * 1000).toISOString().slice(0, 19);

function generate(): Punch[] {
  const punches: Punch[] = [];
  for (const p of PEOPLE) {
    const r = rng(1000 + p.no);
    const start = (p.shift ?? NOOR_ACTUAL_START) * 60;
    for (const d of dayList("2026-06-01", "2026-08-31")) {
      if (d < p.joined) continue;
      const rest = REST_DAY_WORK.find((x) => x.no === p.no && x.date === d);
      if (rest) {
        const [ih, im] = rest.in.split(":").map(Number) as [number, number]; const [oh, om] = rest.out.split(":").map(Number) as [number, number];
        punches.push({ no: p.no, ts: at(d, ih * 60 + im, Math.floor(r() * 60)), label: "C/In", verify: p.verify },
                     { no: p.no, ts: at(d, oh * 60 + om, Math.floor(r() * 60)), label: "C/Out", verify: p.verify });
        continue;
      }
      if (wd(d) > 5 || HOLIDAYS.some((h) => h.date === d) || ABSENT[p.no]?.includes(d)) { r(); r(); r(); continue; }
      if (LEAVE.some((l) => l.no === p.no && d >= l.from && d <= l.to)) { r(); r(); r(); continue; }
      const b = BOUNDARY.find((x) => x.no === p.no && x.date === d);
      let inSec = b ? b.lateBySec : Math.round((p.arrive + gauss(r) * p.arriveSd) * 60);
      if (!b && r() < p.lateP) inSec = Math.round((11 + r() * 37) * 60) + Math.floor(r() * 60);   // 11-48 min late
      if (!b && inSec > 600 && inSec < 660) inSec = 540;                                          // keep random arrivals off the boundary
      const outSec = Math.round((9 * 60 + 6 + gauss(r) * 9) * 60);                                 // ~9h06m after start
      const miss = r();
      const keepIn = !(miss < p.missP / 2), keepOut = !(miss >= p.missP / 2 && miss < p.missP);
      const mislabel = r() < 0.06;                                                                // wrong button on the device
      if (keepIn) punches.push({ no: p.no, ts: at(d, start, inSec), label: "C/In", verify: p.verify });
      if (keepOut) punches.push({ no: p.no, ts: at(d, start, inSec > 0 ? Math.max(outSec, inSec + 7.5 * 3600) : outSec), label: mislabel ? "C/In" : "C/Out", verify: p.verify });
      if (r() < 0.035 && keepIn) { const first = punches.at(-1 - (keepOut ? 1 : 0))!; punches.push({ ...first, ts: new Date(Date.parse(`${first.ts}Z`) + (1 + Math.floor(r() * 44)) * 1000).toISOString().slice(0, 19) }); }
    }
  }
  return punches.sort((a, b) => a.no - b.no || a.ts.localeCompare(b.ts));
}

const fmtDevice = (ts: string) => {
  const [d, t] = ts.split("T") as [string, string];
  const [y, m, dd] = d.split("-").map(Number) as [number, number, number];
  let [h, mi, s] = t.split(":").map(Number) as [number, number, number];
  const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
  return `${m}/${dd}/${y} ${h}:${String(mi).padStart(2, "0")}:${String(s).padStart(2, "0")} ${ap}`;
};
function exportCsv(punches: Punch[], from: string, to: string): string {
  const rows = punches.filter((p) => p.ts >= from && p.ts < to);
  const header = "Department,Name,No.,Date/Time,Status,Location ID,ID Number,Workcode,VerifyCode,CardNo";
  return [header, ...rows.map((p) => ["Empire Networks", PEOPLE.find((x) => x.no === p.no)!.name, p.no, fmtDevice(p.ts), p.label, 101, "", 0, p.verify, ""].join(","))].join("\r\n") + "\r\n";
}

// ------------------------------------------------------------ run through the app
const { setupClean } = await import("./setup-clean.ts");
const h = await setupClean();
const { createEmployee, linkAccount } = await import("../../src/server/services/employees.ts");
const { createDevice, proposeMapping, uploadBatch, listBatches, getBatch } = await import("../../src/server/services/attendance.ts");
const { setSalary, salaryHistory } = await import("../../src/server/services/salary.ts");
const { runImportJobs } = await import("../../src/server/jobs/attendance-import.ts");
const { calculate, approveAndLock, reopen, payrollMonth, payslip } = await import("../../src/server/services/payroll.ts");
const { monthReport } = await import("../../src/server/services/reports.ts");
const { listConfig, listApprovals } = await import("../../src/server/services/approvals.ts");
const { checklist } = await import("../../src/server/services/documents.ts");
const { summary } = await import("../../src/server/services/dashboard.ts");

const punches = generate();
const files = [
  { name: "ZK101_AttLog_20260601-20260701.csv", from: "2026-06-01T12:00:00", to: "2026-07-01T12:00:00", start: "2026-06-01", end: "2026-07-01", exported: "2026-07-01T10:15:00" },
  { name: "ZK101_AttLog_20260701-20260716.csv", from: "2026-07-01T12:00:00", to: "2026-07-16T12:00:00", start: "2026-07-01", end: "2026-07-16", exported: "2026-07-16T10:05:00" },
  { name: "ZK101_AttLog_20260701-20260801.csv", from: "2026-07-01T12:00:00", to: "2026-08-01T12:00:00", start: "2026-07-01", end: "2026-08-01", exported: "2026-08-01T10:20:00" },
  { name: "ZK101_AttLog_20260801-20260901.csv", from: "2026-08-01T12:00:00", to: "2026-09-01T12:00:00", start: "2026-08-01", end: "2026-09-01", exported: "2026-09-01T10:10:00" },
];
for (const f of files) writeFileSync(path.join(OUT, "device-exports", f.name), exportCsv(punches, f.from, f.to));

const HR = "hr", ADMIN = "admin";
const deptIds = Object.fromEntries((await h.owner`select code, id from hr.department`).map((r) => [r.code, r.id]));
const DEPT = { Operations: deptIds.OPS, Quality: deptIds.QA, Sales: deptIds.SALES, Administration: deptIds.ADMIN };
const cal = async (hour: number) => (await h.owner`select hr.ensure_shift_calendar(${hour}) as id`)[0]!.id as string;

// documents: CNIC + signed contract + bank letter required for fixed-monthly staff
const cats = await h.owner`insert into hr.document_category (code, name, sensitivity, has_expiry) values
  ('CNIC', 'CNIC copy', 'highly_sensitive', true), ('CONTRACT', 'Signed employment contract', 'sensitive', false),
  ('BANK_LETTER', 'Bank account letter', 'highly_sensitive', false) returning id, code`;
for (const c of cats) {
  const [r] = await h.owner`insert into hr.approval_request (kind, subject_table, subject_id, requested_by, reason, status, decided_at)
    values ('document_requirement', 'document_requirement', gen_random_uuid(), ${h.U.hr}, 'Required for payroll', 'approved', now()) returning id`;
  await h.owner`insert into hr.document_requirement (category_id, employment_category, is_required, legal_basis_note, valid_during, status, approval_request_id)
    values (${c.id}, 'fixed_monthly', true, 'Identity, contract and salary account for payroll', daterange('2020-01-01', null), 'approved', ${r!.id})`;
}
const empId: Record<number, string> = {};
const deviceId = await h.as(HR, (c) => createDevice(c, { name: "Main entrance (ZKTeco)", location_code: "101",
  datetime_format: "M/D/YYYY h:mm:ss AM", in_label: "C/In", out_label: "C/Out" }));
await h.owner`update hr.device set serial_number = 'ZK-MOCK-0101' where id = ${deviceId}`;
for (const p of [...PEOPLE].sort((a, b) => (a.lead ? 1 : 0) - (b.lead ? 1 : 0) || a.no - b.no)) {
  if (p.no === 15) continue; // created by the August import
  empId[p.no] = await h.as(HR, async (c) => createEmployee(c, {
    employee_code: `EN-${String(p.no).padStart(4, "0")}`, full_name: p.name, employment_category: "fixed_monthly",
    joining_date: p.joined, department_id: DEPT[p.dept], job_title: p.title,
    manager_employee_id: p.lead ? empId[p.lead] : undefined, calendar_id: p.shift ? await cal(p.shift) : undefined,
    probation_end: p.probationEnd, contract_end: p.contractEnd }));
  await h.as(HR, (c) => proposeMapping(c, { device_id: deviceId, enrollment_no: String(p.no), employee_id: empId[p.no]!,
    expected_name: p.name, valid_from: p.joined }));
  for (const [m, pkrAmt] of p.salary) await h.as(HR, (c) => setSalary(c, { employee_id: empId[p.no]!, salary_pkr: pkrAmt, from_month: m }));
}
await h.as(ADMIN, (c) => linkAccount(c, empId[10]!, h.U.hr)); // Hira Shah is the HR user

// holidays and leave (entered as approved records, as HR would in the leave module)
for (const x of HOLIDAYS) {
  const [r] = await h.owner`insert into hr.approval_request (kind, subject_table, subject_id, requested_by, reason, status, decided_at)
                            values ('holiday', 'holiday', gen_random_uuid(), ${h.U.hr}, ${`${x.name} (public holiday)`}, 'approved', now()) returning id`;
  await h.owner`insert into hr.holiday (holiday_date, name, applies_to_all, status, approval_request_id) values (${x.date}, ${x.name}, true, 'approved', ${r!.id})`;
}
await h.owner`insert into hr.leave_type (code, name, is_paid) values ('ANNUAL', 'Annual leave', true), ('SICK', 'Sick leave', true)`;
async function approveLeave(l: (typeof LEAVE)[number]) {
  const [r] = await h.owner`insert into hr.approval_request (kind, subject_table, subject_id, subject_employee_id, requested_by, reason, status, decided_at)
    values ('leave', 'leave_request', gen_random_uuid(), ${empId[l.no]!}, ${h.U.hr}, ${`${l.type === "SICK" ? "Sick" : "Annual"} leave ${l.from} to ${l.to}`}, 'approved', now()) returning id`;
  await h.owner`insert into hr.leave_request (employee_id, leave_type_id, start_date, end_date, reason, requested_by, approval_request_id)
    select ${empId[l.no]!}, id, ${l.from}, ${l.to}, 'Simulation', ${h.U.hr}, ${r!.id} from hr.leave_type where code = ${l.type}`;
}
for (const l of LEAVE.filter((x) => !x.approvedAfterJulyLock)) await approveLeave(l);

const DOC_GAPS: Record<number, Record<string, string>> = { 13: { BANK_LETTER: "requested" }, 5: { CNIC: "expired" }, 3: { CONTRACT: "uploaded" } };
for (const p of PEOPLE.filter((x) => x.no !== 15)) for (const c of cats) {
  const st = DOC_GAPS[p.no]?.[c.code] ?? "accepted";
  await h.owner`update hr.employee_document set status = ${st}::hr.document_status,
                expiry_date = ${c.code === "CNIC" ? (st === "expired" ? "2026-09-30" : "2031-03-31") : null}
                where employee_id = ${empId[p.no]!} and category_id = ${c.id}`;
}

// imports + payroll, in the order HR would really do it
const imports: unknown[] = [];
async function upload(f: (typeof files)[number]) {
  const data = new TextEncoder().encode(exportCsv(punches, f.from, f.to));
  const id = await h.as(HR, (c) => uploadBatch(c, h.storage, { deviceId, filename: f.name, data, claimedStart: f.start, claimedEnd: f.end }));
  await h.owner`update hr.attendance_import_batch set uploaded_at = ${f.exported}::timestamp at time zone 'Asia/Karachi' + interval '25 minutes' where id = ${id}`;
  await runImportJobs(h.storage);
  const b = await h.as(HR, (c) => getBatch(c, id));
  imports.push({ id, filename: f.name, device: "Main entrance (ZKTeco)", device_location: "101", device_serial: "ZK-MOCK-0101",
    period_start: f.start, period_end: f.end, exported_at_local: f.exported, status: b.status, source_rows: b.total_rows,
    valid_punches: b.parsed_rows, error_rows: b.error_rows, recorded: b.promoted_punches, duplicates: b.duplicate_punches,
    flags: b.flag_counts, people: b.people.length,
    auto_created: b.people.filter((p) => p.employee_code && !Object.values(empId).includes(p.employee_id!)).map((p) => p.employee_code) });
  return id;
}
await upload(files[0]!);
await h.as(HR, (c) => calculate(c, "2026-06"));
let run = (await h.as(ADMIN, (c) => payrollMonth(c, "2026-06"))).current!;
await h.as(ADMIN, (c) => approveAndLock(c, run.id, "June 2026 checked against attendance"));

await upload(files[1]!); await upload(files[2]!);
await h.as(HR, (c) => calculate(c, "2026-07"));
run = (await h.as(ADMIN, (c) => payrollMonth(c, "2026-07"))).current!;
await h.as(ADMIN, (c) => approveAndLock(c, run.id, "July 2026 checked against attendance"));
const julyV1Snapshot = (await h.owner`select encode(content_hash, 'hex') as h, content from hr.payroll_snapshot where run_id = ${run.id}`)[0]!;
for (const l of LEAVE.filter((x) => x.approvedAfterJulyLock)) await approveLeave(l);
await h.as(ADMIN, (c) => reopen(c, run.id, "Annual leave for Fatima Noor (20 to 21 Jul) approved after payroll was locked"));
await h.as(HR, (c) => calculate(c, "2026-07"));
run = (await h.as(ADMIN, (c) => payrollMonth(c, "2026-07"))).current!;
await h.as(ADMIN, (c) => approveAndLock(c, run.id, "July 2026 version 2: leave corrected"));

await upload(files[3]!);
empId[15] = (await h.owner`select employee_id from hr.punch_mapping where enrollment_no = '15'`)[0]!.employee_id;
await h.owner`update hr.employee_assignment set job_title = 'Customer Support Agent' where employee_id = ${empId[15]!}`;
await h.owner`insert into hr.manager_assignment (employee_id, manager_employee_id, valid_during) values (${empId[15]!}, ${empId[2]!}, daterange('2026-08-17', null))`;
await h.as(HR, (c) => calculate(c, "2026-08"));
run = (await h.as(ADMIN, (c) => payrollMonth(c, "2026-08"))).current!;
await h.as(ADMIN, (c) => approveAndLock(c, run.id, "August 2026 checked against attendance"));

// ------------------------------------------------------------ export what the APP calculated
const months = ["2026-06", "2026-07", "2026-08"];
const out: Record<string, unknown> = {
  _about: "Canonical mock dataset for Empire HR. Generated by scripts/mock/simulate.ts: device exports were uploaded through the real import pipeline and payroll was run by the real payroll service. Every figure below was calculated by the application. Money is in paisa (1 PKR = 100 paisa).",
  generated_with: { seed: "per-employee mulberry32(1000 + no)", engine: "pay-rules/2026-10-19", now_local: new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 19) },
  company: { name: "Empire Networks Pvt Ltd", timezone: "Asia/Karachi", currency: "PKR", working_days: "Monday to Friday", mode: "single-admin (no approval steps)", payroll: "on, before tax", payments: "off (paid from the bank)" },
  devices: [{ id: deviceId, name: "Main entrance (ZKTeco)", location_id: "101", serial: "ZK-MOCK-0101", date_format: "M/D/YYYY h:mm:ss AM", labels: { in: "C/In", out: "C/Out" } }],
  rules: (await h.as(ADMIN, (c) => listConfig(c))).filter((r) => r.status === "approved").map((r) => ({ key: r.key, value: r.value, from: r.valid_from })),
  holidays: HOLIDAYS, leave: LEAVE.map((l) => ({ employee_code: `EN-${String(l.no).padStart(4, "0")}`, ...l })),
  imports,
};
const people = await h.as(ADMIN, async (c) => {
  const res = [];
  for (const p of PEOPLE) {
    const id = empId[p.no]!;
    const [e] = await c.tx`select e.employee_code, e.full_name, e.status::text as status, e.joining_date, ea.job_title, d.name as department,
                                  m.full_name as manager, s.name as shift, (select probation_end from hr.current_probation where employee_id = e.id) as probation_end,
                                  (select contract_end from hr.current_contract where employee_id = e.id) as contract_end,
                                  (e.created_by = '00000000-0000-0000-0000-00000000a071') as auto_created
                           from hr.employee e
                           left join lateral (select * from hr.employee_assignment where employee_id = e.id order by lower(valid_during) desc limit 1) ea on true
                           left join hr.department d on d.id = ea.department_id
                           left join lateral (select me.full_name from hr.manager_assignment ma join hr.employee me on me.id = ma.manager_employee_id where ma.employee_id = e.id limit 1) m on true
                           left join lateral (select sh.name from hr.employee_calendar_assignment eca join hr.work_calendar_rule r on r.calendar_id = eca.calendar_id and r.shift_id is not null
                                              join hr.shift sh on sh.id = r.shift_id where eca.employee_id = e.id limit 1) s on true
                           where e.id = ${id}`;
    const docs = (await checklist(c, id)).map((d) => ({ document: d.category_name, status: d.status, expiry: d.expiry_date }));
    res.push({ ...e, employee_id: id, enrollment_no: String(p.no),
      salary_history: (await salaryHistory(c, id)).map((x) => ({ monthly_paisa: Number(x.salary_paisa), from: x.from, to: x.to, status: x.status })),
      documents: docs, documents_complete: `${docs.filter((d) => d.status === "accepted").length} of ${docs.length}` });
  }
  return res;
});
out.employees = people;
out.months = {};
for (const m of months) {
  const rep = await h.as(ADMIN, (c) => monthReport(c, { month: m }));
  const pay = await h.as(ADMIN, (c) => payrollMonth(c, m));
  const versions = [];
  for (const r of pay.runs) {
    const lines = r.status === "superseded"
      ? ((await h.owner`select content from hr.payroll_snapshot where run_id = ${r.id}`)[0]?.content as { lines: unknown[] } | undefined)?.lines ?? []
      : await h.as(ADMIN, async (c) => { const ls = []; for (const l of pay.lines) ls.push(await payslip(c, r.id, l.employee_id)); return ls; });
    versions.push({ version: r.version, status: r.status, reopen_reason: r.reopen_reason, lines });
  }
  const t = (f: (x: (typeof rep.people)[number]) => number) => rep.people.reduce((s, p) => s + f(p), 0);
  (out.months as Record<string, unknown>)[m] = {
    rules_applied: rep.policy,
    overview: {
      employees: rep.people.length,
      gross_paisa: t((p) => p.result.totals.grossPaisa ?? 0), deductions_paisa: t((p) => p.salary_paisa === null ? 0 : p.result.totals.totalDeductionPaisa),
      net_paisa: t((p) => p.result.totals.netPaisa ?? 0), late_days: t((p) => p.result.totals.late), absent_days: t((p) => p.result.totals.absent),
      needs_review_days: t((p) => p.result.totals.incomplete), leave_days: t((p) => p.result.totals.leave), holiday_days: t((p) => p.result.totals.holiday),
      exclusions: rep.people.filter((p) => p.salary_paisa === null).map((p) => ({ employee_code: p.employee_code, reason: "no salary configured: excluded from money totals and payroll" })),
      warnings: rep.people.filter((p) => !p.shift).map((p) => ({ employee_code: p.employee_code, reason: "no shift configured: lateness and absence cannot be judged; paid in full" })),
    },
    employees: rep.people.map((p) => ({ employee_code: p.employee_code, full_name: p.full_name, shift: p.shift?.name ?? null,
      salary_monthly_paisa: p.salary_paisa, totals: p.result.totals,
      days: p.result.days.map((d) => ({ date: d.date, weekday: d.weekday, status: d.status, scheduled_start: d.scheduledStart, in: d.firstIn, out: d.lastOut,
        punches: d.punches, worked_minutes: d.workedMinutes, late_minutes: d.lateMinutes, deduction_paisa: d.deductionPaisa, note: d.note })) })),
    payroll: { current_version: pay.current?.version, status: pay.current?.status, approval: pay.approval, versions },
  };
}
out.dashboard_now = await h.as(ADMIN, (c) => summary(c));
out.approvals_history = (await h.as(ADMIN, (c) => listApprovals(c, { limit: 200 }))).map((a) => ({ kind: a.kind, status: a.status, reason: a.reason, decision: a.decision_reason, at: a.decided_at }));
out._checks_input = { july_v1_snapshot_hash: julyV1Snapshot.h, july_v1_snapshot_now: (await h.owner`select encode(content_hash, 'hex') as h from hr.payroll_snapshot where content_hash = decode(${julyV1Snapshot.h}, 'hex')`)[0]?.h ?? null,
  generated_punches: punches.length, raw_punches_in_db: (await h.owner`select count(*)::int as n from hr.raw_punch`)[0]!.n };
writeFileSync(path.join(OUT, "fixture.json"), JSON.stringify(out, null, 2));
console.log(`fixture written: ${OUT}/fixture.json; punches generated ${punches.length}, in database ${(out._checks_input as { raw_punches_in_db: number }).raw_punches_in_db}`);
await h.teardown(false);
