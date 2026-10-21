"use client";
import { useEffect, useState } from "react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ReferenceArea, ReferenceLine,
  ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis,
} from "recharts";

/* SVG attributes can't read CSS variables, so resolve the design tokens at
   runtime and re-resolve when the theme changes. */
const KEYS = ["ok", "warn", "bad", "review", "info", "accent", "accent-bright", "ink", "ink-2", "ink-3", "line", "surface", "navy"] as const;
type Tokens = Record<(typeof KEYS)[number], string>;
const FALLBACK: Tokens = { ok: "#15966A", warn: "#D97706", bad: "#DC4545", review: "#805AD5", info: "#2784D8", accent: "#087F8C", "accent-bright": "#12B8B0",
  ink: "#172B45", "ink-2": "#4A5B72", "ink-3": "#64748B", line: "#E2E8F0", surface: "#FFFFFF", navy: "#10213A" };
export function useTokens(): Tokens {
  const [t, setT] = useState<Tokens>(FALLBACK);
  useEffect(() => {
    const read = () => { const cs = getComputedStyle(document.documentElement);
      setT(Object.fromEntries(KEYS.map((k) => [k, cs.getPropertyValue(`--${k}`).trim() || FALLBACK[k]])) as Tokens); };
    read();
    const mo = new MutationObserver(read); mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = matchMedia("(prefers-color-scheme: dark)"); mq.addEventListener("change", read);
    return () => { mo.disconnect(); mq.removeEventListener("change", read); };
  }, []);
  return t;
}

export const pkr0 = (p: number) => (p / 100).toLocaleString("en-PK", { maximumFractionDigits: 0 });
export const pkr2 = (p: number) => (p / 100).toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shortMonth = (m: string) => new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-01T00:00:00Z`));
const dayLabel = (d: string) => new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));

function useAxis(t: Tokens) {
  return { tick: { fill: t["ink-3"], fontSize: 11.5 }, axisLine: { stroke: t.line }, tickLine: false as const };
}
function Tip({ active, payload, label, render }: { active?: boolean; payload?: { name: string; value: number; color: string; payload: Record<string, unknown> }[];
  label?: string; render?: (p: Record<string, unknown>) => React.ReactNode }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-[12.5px] shadow-lg">
      {render ? render(payload[0]!.payload) : (<>
        {label ? <p className="mb-1 font-semibold">{label}</p> : null}
        {payload.map((p) => <p key={p.name} className="flex items-center gap-2"><span className="size-2 rounded-full" style={{ background: p.color }} />{p.name}<b className="ml-auto pl-3 tabular-nums">{p.value}</b></p>)}
      </>)}
    </div>);
}

/* ----------------------------------------------------------------- cards */
export function ChartCard({ title, legend, children, table, className = "" }:
  { title: string; legend?: React.ReactNode; children: React.ReactNode; table?: React.ReactNode; className?: string }) {
  const [mode, setMode] = useState<"chart" | "table">("chart");
  return (
    <section className={`panel flex min-w-0 flex-col p-4 ${className}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {table ? (
          <div role="group" aria-label={`${title} view`} className="flex rounded-lg border border-line p-0.5 text-[12.5px]">
            {(["chart", "table"] as const).map((m) => (
              <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m}
                className={`rounded-md px-2.5 py-1 font-medium capitalize ${mode === m ? "bg-accent text-accent-ink" : "text-ink-2 hover:text-ink"}`}>{m}</button>))}
          </div>) : null}
      </div>
      {legend && mode === "chart" ? <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-ink-2">{legend}</div> : null}
      <div className="min-h-0 flex-1">{mode === "chart" ? children : <div className="max-h-[280px] overflow-auto">{table}</div>}</div>
    </section>);
}
export const Dot = ({ color, label }: { color: string; label: string }) => (
  <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full" style={{ background: `var(--${color})` }} />{label}</span>);

/* --------------------------------------------------------------- sparkline */
export function Sparkline({ data, color = "accent" }: { data: number[]; color?: "accent" | "warn" | "bad" | "ok" }) {
  const t = useTokens();
  if (data.length < 2) return <div className="h-8" />;
  const pts = data.map((v, i) => ({ i, v }));
  return (
    <div className="h-8" aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={pts} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
          <defs><linearGradient id={`sp-${color}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={t[color]} stopOpacity={0.25} /><stop offset="100%" stopColor={t[color]} stopOpacity={0} /></linearGradient></defs>
          <Area type="monotone" dataKey="v" stroke={t[color]} strokeWidth={1.75} fill={`url(#sp-${color})`} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>);
}

/* ---------------------------------------------------- attendance by day */
type DayRow = { date: string; weekday: number; onTime: number; late: number; absent: number; review: number; holiday: boolean };
export function AttendanceByDay({ data }: { data: DayRow[] }) {
  const t = useTokens(); const ax = useAxis(t);
  const rows = data.filter((d) => d.weekday <= 5).map((d) => ({ ...d, label: dayLabel(d.date) }));
  return (
    <div className="h-[230px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: -18 }} barCategoryGap="22%">
          <CartesianGrid vertical={false} stroke={t.line} strokeDasharray="3 3" />
          <XAxis dataKey="label" {...ax} interval="preserveStartEnd" minTickGap={18} />
          <YAxis {...ax} allowDecimals={false} />
          <Tooltip cursor={{ fill: t.line, opacity: 0.35 }} content={<Tip render={(p) => (<>
            <p className="mb-1 font-semibold">{dayLabel(String(p.date))}{p.holiday ? " (holiday)" : ""}</p>
            {([["On time", "onTime", t.ok], ["Late", "late", t.warn], ["Absent", "absent", t.bad], ["Needs review", "review", t.review]] as const).map(([l, k, c]) => (
              <p key={k} className="flex items-center gap-2"><span className="size-2 rounded-full" style={{ background: c }} />{l}<b className="ml-auto pl-4 tabular-nums">{String(p[k])}</b></p>))}
            <p className="mt-1 border-t border-line pt-1 font-semibold">Total <span className="float-right tabular-nums">{Number(p.onTime) + Number(p.late) + Number(p.absent) + Number(p.review)}</span></p>
          </>)} />} />
          <Bar dataKey="onTime" name="On time" stackId="a" fill={t.ok} />
          <Bar dataKey="late" name="Late" stackId="a" fill={t.warn} />
          <Bar dataKey="absent" name="Absent" stackId="a" fill={t.bad} />
          <Bar dataKey="review" name="Needs review" stackId="a" fill={t.review} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>);
}

/* ----------------------------------------------- deductions by employee */
export function DeductionsByEmployee({ data }: { data: { name: string; lateCut: number; absenceCut: number }[] }) {
  const t = useTokens(); const ax = useAxis(t);
  const rows = data.map((d) => ({ ...d, late: d.lateCut / 100, absence: d.absenceCut / 100, total: (d.lateCut + d.absenceCut) / 100 }));
  if (!rows.length) return <p className="py-10 text-center text-[13.5px] text-ink-3">No deductions this month.</p>;
  return (
    <div style={{ height: Math.max(160, rows.length * 26 + 30) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 48, bottom: 0, left: 6 }} barCategoryGap="28%">
          <CartesianGrid horizontal={false} stroke={t.line} strokeDasharray="3 3" />
          <XAxis type="number" {...ax} tickFormatter={(v: number) => v >= 1000 ? `${v / 1000}K` : String(v)} />
          <YAxis type="category" dataKey="name" {...ax} width={104} />
          <Tooltip cursor={{ fill: t.line, opacity: 0.35 }} content={<Tip render={(p) => (<>
            <p className="mb-1 font-semibold">{String(p.name)}</p>
            <p>Late cut <b className="float-right pl-4 tabular-nums">PKR {Number(p.late).toLocaleString("en-PK", { minimumFractionDigits: 2 })}</b></p>
            <p>Absence cut <b className="float-right pl-4 tabular-nums">PKR {Number(p.absence).toLocaleString("en-PK", { minimumFractionDigits: 2 })}</b></p>
          </>)} />} />
          <Bar dataKey="late" name="Late cut" stackId="d" fill={t.warn} />
          <Bar dataKey="absence" name="Absence cut" stackId="d" fill={t.bad} radius={[0, 3, 3, 0]}
            label={{ position: "right", fill: t["ink-2"], fontSize: 11.5, formatter: (_: unknown, __: unknown, i: number) => rows[i] ? rows[i]!.total.toLocaleString("en-PK", { maximumFractionDigits: 0 }) : "" } as never} />
        </BarChart>
      </ResponsiveContainer>
    </div>);
}

/* ------------------------------------------------------------- donut */
export function StatusDonut({ data, centre, centreLabel }: { data: { key: string; label: string; value: number }[]; centre: string; centreLabel: string }) {
  const t = useTokens();
  const color: Record<string, string> = { onTime: t.ok, late: t.warn, absent: t.bad, review: t.review };
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="relative h-[170px] w-[170px] shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="label" innerRadius={52} outerRadius={80} paddingAngle={1.5} stroke="none" isAnimationActive={false}>
              {data.map((d) => <Cell key={d.key} fill={color[d.key]} />)}
            </Pie>
            <Tooltip content={<Tip render={(p) => <p><b>{String(p.label)}</b>: {String(p.value)} day{p.value === 1 ? "" : "s"}</p>} />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div><p className="text-[26px] leading-none font-bold tabular-nums">{centre}</p><p className="mt-1 text-[11.5px] text-ink-3">{centreLabel}</p></div>
        </div>
      </div>
      <ul className="min-w-40 flex-1 space-y-2 text-[13px]">
        {data.map((d) => (
          <li key={d.key} className="flex items-center gap-2"><span className="size-2.5 rounded-full" style={{ background: color[d.key] }} />{d.label}
            <span className="ml-auto tabular-nums text-ink-2">{Math.round((d.value / total) * 100)}% ({d.value})</span></li>))}
      </ul>
    </div>);
}

/* ------------------------------------------------------- financial trend */
export function FinancialTrend({ data }: { data: { month: string; net: number; deductions: number }[] }) {
  const t = useTokens(); const ax = useAxis(t);
  if (data.length < 2) return <p className="py-10 text-center text-[13.5px] text-ink-3">The trend appears once two months of attendance are uploaded.</p>;
  const rows = data.map((d) => ({ month: shortMonth(d.month), net: d.net / 100, deductions: d.deductions / 100 }));
  const fmt = (v: number) => v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${Math.round(v / 1000)}K` : String(v);
  return (
    <div className="h-[210px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: -6 }}>
          <CartesianGrid vertical={false} stroke={t.line} strokeDasharray="3 3" />
          <XAxis dataKey="month" {...ax} />
          <YAxis yAxisId="net" {...ax} tickFormatter={fmt} />
          <YAxis yAxisId="ded" orientation="right" {...ax} tickFormatter={fmt} />
          <Tooltip content={<Tip render={(p) => (<><p className="mb-1 font-semibold">{String(p.month)}</p>
            <p>Net pay <b className="float-right pl-4 tabular-nums">PKR {Number(p.net).toLocaleString("en-PK", { maximumFractionDigits: 0 })}</b></p>
            <p>Deductions <b className="float-right pl-4 tabular-nums">PKR {Number(p.deductions).toLocaleString("en-PK", { maximumFractionDigits: 0 })}</b></p></>)} />} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12.5, color: t["ink-2"] }} />
          <Line yAxisId="net" type="linear" dataKey="net" name="Net pay (left)" stroke={t.accent} strokeWidth={2.25} dot={{ r: 3 }} />
          <Line yAxisId="ded" type="linear" dataKey="deductions" name="Deductions (right)" stroke={t.warn} strokeWidth={2} dot={{ r: 3 }} strokeDasharray="5 3" />
        </LineChart>
      </ResponsiveContainer>
    </div>);
}

/* ------------------------------------- one employee: clock-in vs shift */
export function ClockInChart({ data, grace }: { data: { date: string; minutes: number; late: boolean }[]; grace: number }) {
  const t = useTokens(); const ax = useAxis(t);
  if (!data.length) return <p className="py-10 text-center text-[13.5px] text-ink-3">No clock-ins this month.</p>;
  const rows = data.map((d) => ({ ...d, x: Number(d.date.slice(8, 10)) }));
  const lo = Math.min(-30, ...rows.map((r) => r.minutes)) - 5, hi = Math.max(grace + 15, ...rows.map((r) => r.minutes)) + 5;
  return (
    <div className="h-[220px]">
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
          <CartesianGrid stroke={t.line} strokeDasharray="3 3" />
          <XAxis type="number" dataKey="x" name="Day" domain={[1, 31]} {...ax} tickCount={8} />
          <YAxis type="number" dataKey="minutes" name="Minutes" domain={[lo, hi]} {...ax} tickFormatter={(v: number) => (v > 0 ? `+${v}` : String(v))} />
          <ZAxis range={[44, 44]} />
          <ReferenceArea y1={0} y2={grace} fill={t.ok} fillOpacity={0.1} />
          <ReferenceLine y={0} stroke={t["ink-3"]} strokeDasharray="4 3" label={{ value: "shift start", position: "insideTopLeft", fill: t["ink-3"], fontSize: 11 }} />
          <ReferenceLine y={grace} stroke={t.ok} strokeDasharray="2 3" label={{ value: `+${grace} min grace`, position: "insideTopRight", fill: t.ok, fontSize: 11 }} />
          <Tooltip content={<Tip render={(p) => <p>{dayLabel(String(p.date))}: <b>{Number(p.minutes) > 0 ? `${p.minutes} min after` : `${Math.abs(Number(p.minutes))} min before`}</b> shift start</p>} />} />
          <Scatter data={rows.filter((r) => !r.late)} fill={t.accent} />
          <Scatter data={rows.filter((r) => r.late)} fill={t.warn} shape="diamond" />
        </ScatterChart>
      </ResponsiveContainer>
    </div>);
}

/* ------------------------------------------ one employee: hours per night */
export function HoursChart({ data, scheduled }: { data: { date: string; hours: number }[]; scheduled: number }) {
  const t = useTokens(); const ax = useAxis(t);
  if (!data.length) return <p className="py-10 text-center text-[13.5px] text-ink-3">No complete nights this month.</p>;
  const rows = data.map((d) => ({ ...d, label: d.date.slice(8, 10) }));
  return (
    <div className="h-[220px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: -20 }}>
          <CartesianGrid vertical={false} stroke={t.line} strokeDasharray="3 3" />
          <XAxis dataKey="label" {...ax} />
          <YAxis {...ax} domain={[0, 12]} />
          <ReferenceLine y={scheduled} stroke={t.navy} strokeDasharray="4 3" label={{ value: `${scheduled} h scheduled`, position: "insideTopRight", fill: t["ink-3"], fontSize: 11 }} />
          <Tooltip cursor={{ fill: t.line, opacity: 0.35 }} content={<Tip render={(p) => <p>{dayLabel(String(p.date))}: <b>{Number(p.hours).toFixed(2)} h</b></p>} />} />
          <Bar dataKey="hours" fill={t.accent} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>);
}

/* ----------------------------------------------- payroll: per employee */
export function PayrollStack({ data }: { data: { name: string; net: number; lateCut: number; absenceCut: number }[] }) {
  const t = useTokens(); const ax = useAxis(t);
  const rows = data.map((d) => ({ name: d.name.split(" ")[0], full: d.name, net: d.net / 100, late: d.lateCut / 100, absence: d.absenceCut / 100 }));
  return (
    <div className="h-[240px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} barCategoryGap="24%">
          <CartesianGrid vertical={false} stroke={t.line} strokeDasharray="3 3" />
          <XAxis dataKey="name" {...ax} interval={0} angle={-30} textAnchor="end" height={46} />
          <YAxis {...ax} tickFormatter={(v: number) => `${Math.round(v / 1000)}K`} />
          <Tooltip cursor={{ fill: t.line, opacity: 0.35 }} content={<Tip render={(p) => (<><p className="mb-1 font-semibold">{String(p.full)}</p>
            <p>Net pay <b className="float-right pl-4 tabular-nums">{Number(p.net).toLocaleString("en-PK", { minimumFractionDigits: 2 })}</b></p>
            <p>Late cut <b className="float-right pl-4 tabular-nums">{Number(p.late).toLocaleString("en-PK", { minimumFractionDigits: 2 })}</b></p>
            <p>Absence cut <b className="float-right pl-4 tabular-nums">{Number(p.absence).toLocaleString("en-PK", { minimumFractionDigits: 2 })}</b></p></>)} />} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12.5, color: t["ink-2"] }} />
          <Bar dataKey="net" name="Net pay" stackId="p" fill={t.accent} />
          <Bar dataKey="late" name="Late cut" stackId="p" fill={t.warn} />
          <Bar dataKey="absence" name="Absence cut" stackId="p" fill={t.bad} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>);
}

/* ------------------------------------------------- payroll: waterfall */
export function Waterfall({ gross, late, absence }: { gross: number; late: number; absence: number }) {
  const t = useTokens(); const ax = useAxis(t);
  const net = gross - late - absence;
  const rows = [
    { name: "Gross", base: 0, value: gross / 100, color: t.info },
    { name: "Late cuts", base: (gross - late) / 100, value: late / 100, color: t.warn },
    { name: "Absence cuts", base: net / 100, value: absence / 100, color: t.bad },
    { name: "Net pay", base: 0, value: net / 100, color: t.accent },
  ];
  const lo = Math.max(0, Math.floor((net / 100) * 0.985));
  return (
    <div className="h-[240px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 20, right: 8, bottom: 0, left: 6 }}>
          <CartesianGrid vertical={false} stroke={t.line} strokeDasharray="3 3" />
          <XAxis dataKey="name" {...ax} />
          <YAxis {...ax} domain={[lo, "auto"]} tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}K`} allowDataOverflow />
          <Tooltip cursor={{ fill: t.line, opacity: 0.35 }} content={<Tip render={(p) => <p><b>{String(p.name)}</b>: PKR {Number(p.value).toLocaleString("en-PK", { minimumFractionDigits: 2 })}</p>} />} />
          <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
          <Bar dataKey="value" stackId="w" radius={[3, 3, 0, 0]}
            label={((props: { x?: number; y?: number; width?: number; index?: number }) => {
              const r = rows[props.index ?? 0]!; const cut = r.name.endsWith("cuts");
              return <text x={(props.x ?? 0) + (props.width ?? 0) / 2} y={(props.y ?? 0) - 6} textAnchor="middle" fill={t["ink-2"]} fontSize={11.5}>
                {cut ? "−" : ""}{r.value.toLocaleString("en-PK", { maximumFractionDigits: cut ? 2 : 0 })}</text>;
            }) as never}>
            {rows.map((r) => <Cell key={r.name} fill={r.color} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <p className="-mt-1 text-[11.5px] text-ink-3">Axis starts near net pay so the cuts are visible.</p>
    </div>);
}
