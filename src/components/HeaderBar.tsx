"use client";
import { Bell, Download, Search, Upload } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type Note = { id: string; title: string; body: string; created_at: string; read_at: string | null };
const label = (m: string) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-01T00:00:00Z`));
const when = (iso: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Karachi" }).format(new Date(iso));

/** Compact top bar: employee search, month (for pages that use it), upload, export, notifications, user. */
export function HeaderBar({ staff, months, latest, name, roleLabel, notes, markRead }: {
  staff: boolean; months: string[]; latest: string; name: string; roleLabel: string; notes: Note[]; markRead: () => Promise<void>;
}) {
  const router = useRouter(); const path = usePathname(); const sp = useSearchParams();
  const usesMonth = ["/dashboard", "/reports", "/payroll"].some((p) => path.startsWith(p));
  const month = sp.get("month") ?? latest;
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const unread = notes.filter((n) => !n.read_at).length;
  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close); return () => document.removeEventListener("mousedown", close);
  }, []);
  const all = months.includes(month) ? months : [month, ...months];
  return (
    <div className="flex items-center gap-2">
      {staff ? (
        <form action="/employees" role="search" className="relative hidden max-w-md flex-1 sm:block">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
          <label htmlFor="global-search" className="sr-only">Search employees</label>
          <input id="global-search" name="q" placeholder="Search employees, codes or departments…" className="field rounded-full bg-surface py-2 pl-9" />
        </form>) : <div className="flex-1" />}
      <div className="ml-auto flex items-center gap-2">
        {staff && usesMonth ? (
          <label className="sr-only" htmlFor="hdr-month">Month</label>) : null}
        {staff && usesMonth ? (
          <select id="hdr-month" className="field w-auto py-1.5" value={month}
            onChange={(e) => { const q = new URLSearchParams(sp.toString()); q.set("month", e.target.value); router.push(`${path}?${q}`); }}>
            {all.map((m) => <option key={m} value={m}>{label(m)}</option>)}
          </select>) : null}
        {staff ? <Link href="/attendance" className="btn-primary hidden py-1.5 lg:inline-flex"><Upload aria-hidden className="size-4" />Upload a file</Link> : null}
        {staff ? <a href={`/api/reports/attendance?month=${month}`} className="btn-quiet hidden py-1.5 lg:inline-flex"><Download aria-hidden className="size-4" />Export</a> : null}
        <div className="relative" ref={box}>
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
            className="relative rounded-lg p-2 hover:bg-surface">
            <Bell aria-hidden className="size-5" />
            {unread ? <span className="absolute top-1 right-1 grid min-w-4 place-items-center rounded-full bg-bad px-1 text-[10.5px] font-bold text-white">{unread}</span> : null}
          </button>
          {open ? (
            <div className="panel absolute right-0 z-40 mt-2 w-80 overflow-hidden">
              <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
                <p className="font-semibold">Notifications</p>
                {unread ? <form action={markRead}><button className="text-[13px] text-accent hover:underline">Mark all read</button></form> : null}
              </div>
              {notes.length ? (
                <ul className="max-h-96 divide-y divide-line overflow-y-auto">{notes.map((n) => (
                  <li key={n.id} className={`px-4 py-3 ${n.read_at ? "" : "bg-accent-soft/50"}`}>
                    <p className="text-[13.5px] font-medium">{n.title}</p><p className="text-[12.5px] text-ink-2">{n.body}</p>
                    <p className="mt-0.5 text-[11.5px] text-ink-3">{when(n.created_at)}</p></li>))}</ul>
              ) : <p className="px-4 py-6 text-center text-[13.5px] text-ink-3">You&apos;re all caught up.</p>}
            </div>) : null}
        </div>
        <div className="flex items-center gap-2 pl-1">
          <span className="grid size-9 place-items-center rounded-full bg-navy text-[13px] font-semibold text-white">
            {name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((x) => x[0]!.toUpperCase()).join("")}</span>
          <div className="hidden leading-tight xl:block"><p className="text-[13.5px] font-semibold">{name}</p><p className="text-[12px] text-ink-3">{roleLabel}</p></div>
        </div>
      </div>
    </div>
  );
}
