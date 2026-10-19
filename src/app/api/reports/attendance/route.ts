import { unstable_rethrow } from "next/navigation";
import { NextResponse } from "next/server";
import { runAs } from "@/server/context";
import { toAppError } from "@/server/errors";
import { getPrincipal } from "@/server/session";
import { latestPunchMonth, monthReport } from "@/server/services/reports";

const cell = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
const money = (p: number | null) => (p === null ? "" : (p / 100).toFixed(2));

/** CSV of the same report (summary, or day-by-day for one employee). Staff only; the export is audited. */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const principal = await getPrincipal();
  try {
    const { csv, name } = await runAs(principal, async (c) => {
      const month = sp.get("month") || (await latestPunchMonth(c));
      const rep = await monthReport(c, { month, employeeId: sp.get("employee") || null, shiftCode: sp.get("shift") || null });
      await c.tx`select hr.log_access('attendance_report', ${month}, 'EXPORT', ${sp.toString()})`;
      const people = rep.people.filter((p) => !sp.get("department") || p.department === sp.get("department"));
      if (sp.get("employee") && people[0]) {
        const p = people[0];
        const rows = [["Date", "Shift starts", "In", "Out", "Worked minutes", "Late minutes", "Status", "Deduction PKR", "Note"],
          ...p.result.days.map((d) => [d.date, d.scheduledStart?.slice(11, 16), d.firstIn?.replace("T", " "), d.lastOut?.replace("T", " "),
            d.workedMinutes, d.lateMinutes, d.status, money(d.deductionPaisa), d.note])];
        return { csv: rows.map((r) => r.map(cell).join(",")).join("\r\n"), name: `attendance-${month}-${p.employee_code}.csv` };
      }
      const rows = [["Employee code", "Name", "Department", "Shift", "Salary PKR", "Working days", "On time", "Late", "Late minutes",
        "Absent", "Needs review", "Late deductions PKR", "Absence deductions PKR", "Total deductions PKR", "Net estimate PKR"],
        ...people.map((p) => { const t = p.result.totals; return [p.employee_code, p.full_name, p.department, p.shift?.name, money(p.salary_paisa),
          t.scheduled, t.present, t.late, t.lateMinutes, t.absent, t.incomplete, money(t.lateDeductionPaisa), money(t.absenceDeductionPaisa),
          money(t.totalDeductionPaisa), money(t.netPaisa)]; })];
      return { csv: rows.map((r) => r.map(cell).join(",")).join("\r\n"), name: `attendance-${month}.csv` };
    });
    return new NextResponse("\uFEFF" + csv, { headers: { "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" } });
  } catch (e) {
    unstable_rethrow(e);
    const err = toAppError(e);
    return NextResponse.json({ message: err.message }, { status: err.status });
  }
}
