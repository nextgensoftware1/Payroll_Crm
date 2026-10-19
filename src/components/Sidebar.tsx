"use client";
import clsx from "clsx";
import { Banknote, BarChart3, ClipboardCheck, FileClock, Home, LogOut, Settings, UserRound, Users, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import type { Theme } from "@/lib/theme";
import type { Role } from "@/lib/types";

const NAV = [
  { href: "/dashboard", label: "Overview", icon: Home, roles: ["admin", "hr"] },
  { href: "/employees", label: "Employees", icon: Users, roles: ["admin", "hr", "manager"] },
  { href: "/attendance", label: "Attendance", icon: FileClock, roles: ["admin", "hr"] },
  { href: "/reports", label: "Reports", icon: BarChart3, roles: ["admin", "hr"] },
  { href: "/payroll", label: "Payroll", icon: Banknote, roles: ["admin", "hr"] },
  { href: "/approvals", label: "Approvals", icon: ClipboardCheck, roles: ["admin", "hr", "manager", "employee"] },
  { href: "/me", label: "My Records", icon: UserRound, roles: ["employee", "manager", "hr", "admin"] },
  { href: "/settings", label: "Settings", icon: Settings, roles: ["admin", "hr"] },
] as const;

const initials = (n: string) => n.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((x) => x[0]!.toUpperCase()).join("");
const ROLE: Record<string, string> = { admin: "Admin", hr: "HR", manager: "Manager", employee: "Employee", auditor: "Auditor" };

export function Sidebar({ roles, name, pending, theme, signOut, onNavigate }:
  { roles: Role[]; name: string; pending: number; theme: Theme; signOut: () => Promise<void>; onNavigate?: () => void }) {
  const path = usePathname();
  const items = NAV.filter((n) => n.roles.some((r) => roles.includes(r as Role)));
  const roleLabel = roles.includes("admin") ? "HR Admin" : roles.includes("hr") ? "HR" : ROLE[roles[0] ?? "employee"];
  return (
    <nav aria-label="Main" className="flex h-full flex-col bg-sidebar px-3 pt-4 pb-3 text-sidebar-ink">
      <div className="mb-6 flex items-center gap-2.5 px-2">
        <BrandMark />
        <div className="min-w-0 flex-1"><p className="text-[16px] leading-tight font-bold text-white">Empire HR</p>
          <p className="truncate text-[12px] text-sidebar-ink/80">Empire Networks Pvt Ltd</p></div>
        {onNavigate ? <button type="button" onClick={onNavigate} aria-label="Close menu" className="rounded-md p-1 text-white md:hidden"><X className="size-5" /></button> : null}
      </div>
      <ul className="space-y-1">
        {items.map(({ href, label, icon: Icon }) => {
          const active = path === href || path.startsWith(`${href}/`);
          return (
            <li key={href}>
              <Link href={href} onClick={onNavigate} aria-current={active ? "page" : undefined}
                className={clsx("flex items-center gap-3 rounded-lg px-3 py-2.5 text-[14px] font-medium transition-colors",
                  active ? "bg-accent text-white shadow-[inset_3px_0_0_var(--accent-bright)]" : "hover:bg-white/6 hover:text-white")}>
                <Icon aria-hidden className="size-[18px] shrink-0" strokeWidth={1.9} />
                <span className="flex-1">{label}</span>
                {href === "/approvals" && pending > 0 ? (
                  <span className="min-w-5 rounded-full bg-bad px-1.5 text-center text-[11.5px] font-bold text-white" aria-label={`${pending} waiting`}>{pending}</span>) : null}
              </Link>
            </li>);
        })}
      </ul>
      <div className="mt-auto space-y-3 pt-6">
        <ThemeSwitch initial={theme} />
        <div className="flex items-center gap-2.5 rounded-lg px-2 py-2">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-white/10 text-[13px] font-semibold text-white">{initials(name)}</span>
          <div className="min-w-0"><p className="truncate text-[14px] font-semibold text-white">{name}</p><p className="text-[12px]">{roleLabel}</p></div>
        </div>
        <form action={signOut}>
          <button className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[14px] hover:bg-white/6 hover:text-white" type="submit">
            <LogOut aria-hidden className="size-[18px]" /> Sign out
          </button>
        </form>
      </div>
    </nav>
  );
}
