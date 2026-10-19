import Link from "next/link";

type Day = { date: string; weekday: number; holiday: boolean; rate: number | null; hasData: boolean };
const title = (m: string) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-01T00:00:00Z`));
const shift = (m: string, by: number) => { const [y, mo] = m.split("-").map(Number) as [number, number]; return new Date(Date.UTC(y, mo - 1 + by, 1)).toISOString().slice(0, 7); };

/** Month calendar: working days shaded by attendance rate, rest days grey, holidays amber. */
export function MonthCalendar({ month, days, focus }: { month: string; days: Day[]; focus?: string }) {
  const lead = (days[0]!.weekday + 6) % 7;
  const cell = (d: Day) => {
    if (d.holiday) return "bg-warn-soft text-warn font-semibold";
    if (d.weekday > 5) return "bg-surface-2 text-ink-3";
    if (!d.hasData || d.rate === null) return "border border-line text-ink-2";
    return d.rate >= 95 ? "bg-ok text-white" : d.rate >= 85 ? "bg-ok/75 text-white" : d.rate >= 70 ? "bg-ok/45 text-ink" : "bg-ok/25 text-ink";
  };
  return (
    <section className="panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">{title(month)}</h2>
        <div className="flex gap-1">
          <Link href={`?month=${shift(month, -1)}`} aria-label="Previous month" className="rounded-md px-2 py-0.5 text-ink-2 hover:bg-surface-2">‹</Link>
          <Link href={`?month=${shift(month, 1)}`} aria-label="Next month" className="rounded-md px-2 py-0.5 text-ink-2 hover:bg-surface-2">›</Link>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[11.5px]">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <span key={d} className="pb-1 font-medium text-ink-3">{d}</span>)}
        {Array.from({ length: lead }, (_, i) => <span key={`b${i}`} />)}
        {days.map((d) => (
          <Link key={d.date} href={`?month=${month}&day=${d.date}`} scroll={false}
            title={`${d.date}${d.holiday ? ", holiday" : d.weekday > 5 ? ", rest day" : d.rate !== null && d.hasData ? `, ${d.rate}% attended` : ""}`}
            className={`grid aspect-square place-items-center rounded-full text-[12px] tabular-nums ${cell(d)} ${focus === d.date ? "ring-2 ring-accent ring-offset-1 ring-offset-surface" : ""}`}>
            {Number(d.date.slice(8))}</Link>))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-ink-2">
        <li className="flex items-center gap-1"><span className="size-2.5 rounded-full bg-ok" />Working day (darker = more attended)</li>
        <li className="flex items-center gap-1"><span className="size-2.5 rounded-full bg-surface-2 ring-1 ring-line" />Rest day</li>
        <li className="flex items-center gap-1"><span className="size-2.5 rounded-full bg-warn" />Holiday</li>
      </ul>
    </section>);
}
