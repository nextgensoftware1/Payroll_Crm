"use client";
import { useRouter, useSearchParams } from "next/navigation";

const label = (m: string) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-01T00:00:00Z`));

/** Month dropdown built from the months in your uploaded files. Changing it reloads the page for that month. */
export function MonthPicker({ months, value }: { months: string[]; value: string }) {
  const router = useRouter();
  const sp = useSearchParams();
  const all = months.includes(value) ? months : [value, ...months];
  return (
    <div>
      <label className="label" htmlFor="month-pick">Month</label>
      <select id="month-pick" className="field min-w-48" value={value}
        onChange={(e) => { const q = new URLSearchParams(sp.toString()); q.set("month", e.target.value); router.push(`?${q}`); }}>
        {all.map((m) => <option key={m} value={m}>{label(m)}{months.includes(m) ? "" : " (no data)"}</option>)}
      </select>
    </div>
  );
}
