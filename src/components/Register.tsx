"use client";
import { Search } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { StatusChip } from "@/components/StatusChip";
import type { Overview } from "@/server/services/overview";

const money = (p: number | null) => (p === null ? "—" : (p / 100).toLocaleString("en-PK", { maximumFractionDigits: 0 }));
const day = (d: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));
type SortKey = "code" | "late" | "absent" | "deductions" | "net";

/** Employee attendance register: search, filters and sorting run instantly in the browser. */
export function Register({ data }: { data: Overview }) {
  const router = useRouter(); const sp = useSearchParams();
  const [q, setQ] = useState(""); const [dept, setDept] = useState(""); const [shift, setShift] = useState("");
  const [sort, setSort] = useState<SortKey>("code"); const [page, setPage] = useState(1);
  const depts = [...new Set(data.people.map((p) => p.department).filter(Boolean))] as string[];
  const shifts = [...new Set(data.people.map((p) => p.shift).filter(Boolean))] as string[];
  const rows = useMemo(() => {
    const k = q.trim().toLowerCase();
    const f = data.people.filter((p) => (!k || p.name.toLowerCase().includes(k) || p.code.toLowerCase().includes(k)) && (!dept || p.department === dept) && (!shift || p.shift === shift));
    return [...f].sort((a, b) => sort === "code" ? a.code.localeCompare(b.code) : sort === "late" ? b.late - a.late : sort === "absent" ? b.absent - a.absent
      : sort === "deductions" ? (b.deductions ?? -1) - (a.deductions ?? -1) : (b.net ?? -1) - (a.net ?? -1));
  }, [data.people, q, dept, shift, sort]);
  const per = 10, pages = Math.max(1, Math.ceil(rows.length / per)), shown = rows.slice((page - 1) * per, page * per);
  const sum = (f: (p: (typeof rows)[number]) => number | null) => rows.reduce((s, p) => s + (f(p) ?? 0), 0);
  const days = data.byDay.filter((d) => d.weekday <= 5 || d.onTime + d.late > 0);
  return (
    <section className="panel overflow-hidden">
      <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="mr-auto min-w-0 text-[15px] font-semibold">Employee attendance register</h2>
        <div className="relative"><Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-3" />
          <label className="sr-only" htmlFor="reg-q">Search by name or code</label>
          <input id="reg-q" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search by name or code…" className="field w-56 py-1.5 pl-8" /></div>
        <label className="sr-only" htmlFor="reg-day">Status on day</label>
        <select id="reg-day" className="field w-auto max-w-full py-1.5" value={data.focusDay}
          onChange={(e) => { const s = new URLSearchParams(sp.toString()); s.set("day", e.target.value); router.push(`?${s}`, { scroll: false }); }}>
          {days.map((d) => <option key={d.date} value={d.date}>{day(d.date)}{d.holiday ? " (holiday)" : ""}</option>)}</select>
        <label className="sr-only" htmlFor="reg-dept">Department</label>
        <select id="reg-dept" className="field w-auto max-w-full py-1.5" value={dept} onChange={(e) => { setDept(e.target.value); setPage(1); }}>
          <option value="">All departments</option>{depts.map((d) => <option key={d}>{d}</option>)}</select>
        <label className="sr-only" htmlFor="reg-shift">Shift</label>
        <select id="reg-shift" className="field w-auto max-w-full py-1.5" value={shift} onChange={(e) => { setShift(e.target.value); setPage(1); }}>
          <option value="">All shifts</option>{shifts.map((s) => <option key={s}>{s}</option>)}</select>
        <label className="sr-only" htmlFor="reg-sort">Sort</label>
        <select id="reg-sort" className="field w-auto max-w-full py-1.5" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="code">Sort: code</option><option value="late">Most late</option><option value="absent">Most absent</option>
          <option value="deductions">Highest deductions</option><option value="net">Highest net</option></select>
      </div>
      <div className="overflow-x-auto">
        <table className="table min-w-[1100px]">
          <thead><tr>
            <th scope="col">#</th><th scope="col">Employee</th><th scope="col">Code</th><th scope="col">Shift</th><th scope="col" className="text-right">Salary</th>
            <th scope="col" className="text-right">Working days</th><th scope="col" className="text-right">On time</th><th scope="col" className="text-right">Late</th>
            <th scope="col" className="text-right">Late min</th><th scope="col" className="text-right">Absent</th><th scope="col" className="text-right">Needs review</th>
            <th scope="col" className="text-right">Deductions</th><th scope="col" className="text-right">Net (estimate)</th><th scope="col">{day(data.focusDay)}</th>
          </tr></thead>
          <tbody>{shown.map((p, i) => (
            <tr key={p.id}>
              <td className="text-ink-3 tabular-nums">{(page - 1) * per + i + 1}</td>
              <td><Link href={`/reports?month=${data.month}&employee=${p.id}`} className="flex items-center gap-2 font-medium whitespace-nowrap hover:underline">
                <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">{p.name.split(" ").map((x) => x[0]).slice(0, 2).join("")}</span>{p.name}</Link></td>
              <td className="whitespace-nowrap tabular-nums text-ink-2">{p.code}</td>
              <td className="whitespace-nowrap">{p.shift ?? <Link href={`/employees/${p.id}`} className="text-bad underline">Set shift</Link>}</td>
              <td className="text-right tabular-nums">{p.salary === null ? <Link href={`/employees/${p.id}#salary`} className="text-warn underline">Set salary</Link> : money(p.salary)}</td>
              <td className="text-right tabular-nums">{p.scheduled}</td><td className="text-right tabular-nums">{p.onTime}</td>
              <td className={`text-right tabular-nums ${p.late ? "font-semibold text-warn" : ""}`}>{p.late}</td>
              <td className="text-right tabular-nums">{p.lateMinutes || "—"}</td>
              <td className={`text-right tabular-nums ${p.absent ? "font-semibold text-bad" : ""}`}>{p.absent}</td>
              <td className="text-right tabular-nums">{p.review || "—"}</td>
              <td className="text-right tabular-nums">{p.deductions === null ? "—" : (p.deductions / 100).toLocaleString("en-PK", { minimumFractionDigits: 2 })}</td>
              <td className="text-right font-semibold tabular-nums">{p.net === null ? "—" : (p.net / 100).toLocaleString("en-PK", { minimumFractionDigits: 2 })}</td>
              <td><StatusChip status={p.day.status} /></td>
            </tr>))}</tbody>
          <tfoot><tr className="font-semibold">
            <td /><td>Total ({rows.length})</td><td /><td /><td className="text-right tabular-nums">{money(sum((p) => p.salary))}</td>
            <td className="text-right tabular-nums">{sum((p) => p.scheduled)}</td><td className="text-right tabular-nums">{sum((p) => p.onTime)}</td>
            <td className="text-right tabular-nums">{sum((p) => p.late)}</td><td className="text-right tabular-nums">{sum((p) => p.lateMinutes)}</td>
            <td className="text-right tabular-nums">{sum((p) => p.absent)}</td><td className="text-right tabular-nums">{sum((p) => p.review)}</td>
            <td className="text-right tabular-nums">{(sum((p) => p.deductions) / 100).toLocaleString("en-PK", { minimumFractionDigits: 2 })}</td>
            <td className="text-right tabular-nums">{(sum((p) => p.net) / 100).toLocaleString("en-PK", { minimumFractionDigits: 2 })}</td><td />
          </tr></tfoot>
        </table>
      </div>
      {pages > 1 ? (
        <nav aria-label="Register pages" className="flex flex-wrap items-center justify-end gap-1 px-4 py-2.5 text-[13px]">
          <span className="mr-2 text-ink-3">Showing {(page - 1) * per + 1} to {Math.min(page * per, rows.length)} of {rows.length}</span>
          {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
            <button key={n} type="button" onClick={() => setPage(n)} aria-current={n === page ? "page" : undefined}
              className={`size-8 rounded-md ${n === page ? "bg-accent text-white" : "hover:bg-surface-2"}`}>{n}</button>))}
        </nav>) : null}
    </section>);
}
