"use client";
import clsx from "clsx";
import { Banknote, BarChart3, ClipboardCheck, FileClock, Home, LogOut, PanelLeftClose, PanelLeftOpen, Settings, UserRound, Users, X } from "lucide-react";
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

export function Sidebar({ roles, name, pending, theme, signOut, onNavigate, collapsed = false, onToggleCollapse }:
  { roles: Role[]; name: string; pending: number; theme: Theme; signOut: () => Promise<void>; onNavigate?: () => void;
    collapsed?: boolean; onToggleCollapse?: () => void }) {
  const path = usePathname();
  const items = NAV.filter((n) => n.roles.some((r) => roles.includes(r as Role)));
  const roleLabel = roles.includes("admin") ? "HR Admin" : roles.includes("hr") ? "HR" : ROLE[roles[0] ?? "employee"];
  return (
    <nav aria-label="Main" className={`flex h-full flex-col bg-sidebar pt-4 pb-3 text-sidebar-ink ${collapsed ? "items-center px-2" : "px-3"}`}>
      <div className={`mb-6 flex w-full items-center gap-2.5 ${collapsed ? "flex-col justify-center" : "px-2"}`}>
        <BrandMark />
        {!collapsed ? <div className="min-w-0 flex-1"><p className="text-[16px] leading-tight font-bold text-white">Empire HR</p>
          <p className="truncate text-[12px] text-sidebar-ink/80">Empire Networks Pvt Ltd</p></div>
          : null}
        {onToggleCollapse ? (
          <button type="button" onClick={onToggleCollapse} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"} className="hidden rounded-md p-1 text-sidebar-ink hover:bg-white/10 hover:text-white md:block">
            {collapsed ? <PanelLeftOpen className="size-5" /> : <PanelLeftClose className="size-5" />}
          </button>) : null}
        {onNavigate ? <button type="button" onClick={onNavigate} aria-label="Close menu" className="rounded-md p-1 text-white md:hidden"><X className="size-5" /></button> : null}
      </div>
      <ul className="w-full space-y-1">
        {items.map(({ href, label, icon: Icon }) => {
          const active = path === href || path.startsWith(`${href}/`);
          return (
            <li key={href}>
              <Link href={href} onClick={onNavigate} aria-current={active ? "page" : undefined} aria-label={collapsed ? label : undefined} title={collapsed ? label : undefined}
                className={clsx("relative flex items-center gap-3 rounded-lg py-2.5 text-[14px] font-medium transition-colors",
                  collapsed ? "justify-center px-0" : "px-3",
                  active ? "bg-accent text-white shadow-[inset_3px_0_0_var(--accent-bright)]" : "hover:bg-white/6 hover:text-white")}>
                <Icon aria-hidden className="size-[18px] shrink-0" strokeWidth={1.9} />
                {!collapsed ? <span className="flex-1">{label}</span> : null}
                {href === "/approvals" && pending > 0 ? (
                  <span className={`min-w-5 rounded-full bg-bad px-1.5 text-center text-[11.5px] font-bold text-white ${collapsed ? "absolute translate-x-3 -translate-y-3" : ""}`}
                    aria-label={`${pending} waiting`}>{pending}</span>) : null}
              </Link>
            </li>);
        })}
      </ul>
      <div className={`mt-auto w-full space-y-3 pt-6 ${collapsed ? "flex flex-col items-center" : ""}`}>
        {!collapsed ? <ThemeSwitch initial={theme} /> : (
          <div className="hidden w-full justify-center md:flex">
            <ThemeSwitch initial={theme} compact />
          </div>
        )}
        <div className={`flex items-center gap-2.5 rounded-lg py-2 ${collapsed ? "justify-center px-0" : "px-2"}`} title={collapsed ? `${name}, ${roleLabel}` : undefined}>
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-white/10 text-[13px] font-semibold text-white">{initials(name)}</span>
          {!collapsed ? <div className="min-w-0"><p className="truncate text-[14px] font-semibold text-white">{name}</p><p className="text-[12px]">{roleLabel}</p></div> : null}
        </div>
        <form action={signOut} method="post">
          <button aria-label={collapsed ? "Sign out" : undefined} title={collapsed ? "Sign out" : undefined}
            className={`flex w-full items-center gap-2.5 rounded-lg py-2 text-[14px] hover:bg-white/6 hover:text-white ${collapsed ? "justify-center px-0" : "px-3"}`} type="submit">
            <LogOut aria-hidden className="size-[18px]" />{!collapsed ? "Sign out" : null}
          </button>
        </form>
      </div>
    </nav>
  );
}
