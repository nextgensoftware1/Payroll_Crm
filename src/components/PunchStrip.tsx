import type { Punch } from "@/lib/types";

/** Noon-to-noon strip: a night shift (in at 17:00, out at 03:00) reads as
 *  ONE continuous bar instead of two half-days split at midnight.
 *  This grouping is a review aid only. Official business dates come from
 *  each employee's assigned shift in the attendance engine. */
const H = (ts: string) => { const t = ts.split("T")[1] ?? "00:00:00"; return Number(t.slice(0, 2)) + Number(t.slice(3, 5)) / 60; };
const nightOf = (ts: string) => {
  const d = new Date(`${ts.slice(0, 10)}T00:00:00Z`);
  if (H(ts) < 12) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};
const pos = (ts: string) => (((H(ts) - 12 + 24) % 24) / 24) * 100;
const dayLabel = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));

export function PunchStrip({ punches }: { punches: Punch[] }) {
  const nights = new Map<string, Punch[]>();
  for (const p of punches) nights.set(nightOf(p.local_ts), [...(nights.get(nightOf(p.local_ts)) ?? []), p]);
  const ticks = [["12:00", 0], ["18:00", 25], ["00:00", 50], ["06:00", 75], ["12:00", 100]] as const;
  return (
    <figure>
      <div className="grid grid-cols-[88px_1fr] gap-x-3 text-[12px] text-ink-3" aria-hidden>
        <span />
        <div className="relative h-5">
          {ticks.map(([l, x], i) => (
            <span key={i} className="absolute -translate-x-1/2" style={{ left: `${x}%` }}>{l}</span>
          ))}
        </div>
      </div>
      <ol className="space-y-1.5">
        {[...nights.entries()].map(([night, ps]) => {
          const first = pos(ps[0]!.local_ts), last = pos(ps[ps.length - 1]!.local_ts);
          return (
            <li key={night} className="grid grid-cols-[88px_1fr] items-center gap-x-3">
              <span className="text-[13px] font-medium whitespace-nowrap">{dayLabel(night)}</span>
              <div className="relative h-7 overflow-hidden rounded bg-surface-2">
                {/* night band 18:00 to 06:00 */}
                <span aria-hidden className="absolute inset-y-0 bg-night/15" style={{ left: "25%", width: "50%" }} />
                {ps.length > 1 ? (
                  <span aria-hidden className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-accent/35"
                    style={{ left: `${first}%`, width: `${Math.max(last - first, 0.4)}%` }} />
                ) : null}
                {ps.map((p) => {
                  const flagged = p.flags.length > 0;
                  return (
                    <span key={p.row_number} title={`${p.local_ts.replace("T", " ")}, ${p.status_label}, row ${p.row_number}${flagged ? `, flagged: ${p.flags.join(", ")}` : ""}`}
                      className={`absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2
                        ${p.direction === "in" ? "border-accent bg-accent" : p.direction === "out" ? "border-ink bg-surface" : "border-ink-3 bg-ink-3"}
                        ${flagged ? "ring-2 ring-warn ring-offset-1 ring-offset-surface-2" : ""}`}
                      style={{ left: `${pos(p.local_ts)}%` }} />
                  );
                })}
              </div>
            </li>
          );
        })}
      </ol>
      <figcaption className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-ink-2">
        <span className="flex items-center gap-1.5"><span className="size-3 rounded-full bg-accent" /> Device said In</span>
        <span className="flex items-center gap-1.5"><span className="size-3 rounded-full border-2 border-ink" /> Device said Out</span>
        <span className="flex items-center gap-1.5"><span className="size-3 rounded-full ring-2 ring-warn" /> Flagged for review</span>
        <span>Shaded: 18:00 to 06:00</span>
      </figcaption>
      <details className="mt-3 text-[13.5px]">
        <summary className="cursor-pointer text-accent">Show as a list</summary>
        <div className="mt-2 max-w-full overflow-x-auto">
          <table className="table min-w-[560px]">
            <thead><tr><th scope="col">Row</th><th scope="col">Device time</th><th scope="col">Label</th><th scope="col">Flags</th></tr></thead>
            <tbody>{punches.map((p) => (
              <tr key={p.row_number}><td>{p.row_number}</td><td>{p.local_ts.replace("T", " ")}</td><td>{p.status_label}</td><td>{p.flags.join(", ") || "—"}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
