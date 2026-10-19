import { unstable_rethrow } from "next/navigation";
import { NextResponse } from "next/server";
import { runAs } from "@/server/context";
import { toAppError } from "@/server/errors";
import { getPrincipal } from "@/server/session";
import { linesOf } from "@/server/services/payroll";

const cell = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
const money = (p: number) => (p / 100).toFixed(2);

/** Payroll CSV for one run (staff only; the export is audited). */
export async function GET(req: Request) {
  const run = new URL(req.url).searchParams.get("run") ?? "";
  const principal = await getPrincipal();
  try {
    const csv = await runAs(principal, async (c) => {
      const lines = await linesOf(c, run);
      await c.tx`select hr.log_access('payroll_run', ${run}, 'EXPORT', 'payroll csv')`;
      const comp = (l: (typeof lines)[number], k: string) => l.components.find((x) => x.kind === k);
      const rows = [["Employee code", "Name", "Monthly salary PKR", "Gross PKR", "Late days", "Late cut PKR", "Absent days", "Absence cut PKR", "Total cuts PKR", "Net pay PKR", "Notes"],
        ...lines.map((l) => [l.employee_code, l.full_name, money(l.base_monthly_paisa), money(l.gross_paisa), comp(l, "late")?.days ?? 0,
          money(-(comp(l, "late")?.amount_paisa ?? 0)), comp(l, "absence")?.days ?? 0, money(-(comp(l, "absence")?.amount_paisa ?? 0)),
          money(l.total_deductions_paisa), money(l.net_paisa), l.exceptions_snapshot.map((e) => e.note).join("; ")])];
      return rows.map((r) => r.map(cell).join(",")).join("\r\n");
    }, { roles: ["admin", "hr"] });
    return new NextResponse("\uFEFF" + csv, { headers: { "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="payroll-${run.slice(0, 8)}.csv"`, "Cache-Control": "no-store" } });
  } catch (e) {
    unstable_rethrow(e);
    const err = toAppError(e);
    return NextResponse.json({ message: err.message }, { status: err.status });
  }
}
