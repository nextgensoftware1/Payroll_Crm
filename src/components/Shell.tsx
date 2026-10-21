"use client";
import { Menu } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import type { Theme } from "@/lib/theme";
import type { Role } from "@/lib/types";

/** App frame: fixed navy sidebar on desktop, slide-out drawer on mobile. */
export function Shell({ sidebar, header, children }: {
  sidebar: { roles: Role[]; name: string; pending: number; theme: Theme; signOut: () => Promise<void> };
  header: React.ReactNode; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <div className={`min-h-dvh md:grid ${collapsed ? "md:grid-cols-[76px_minmax(0,1fr)]" : "md:grid-cols-[248px_minmax(0,1fr)]"}`}>
      <aside className="hidden bg-sidebar md:block"><div className="sticky top-0 h-dvh">
        <Sidebar {...sidebar} collapsed={collapsed} onToggleCollapse={() => setCollapsed((value) => !value)} />
      </div></aside>
      {open ? (
        <div id="mobile-menu" className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Main menu">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[272px]"><Sidebar {...sidebar} onNavigate={() => setOpen(false)} /></aside>
        </div>) : null}
      <div className="min-w-0">
        <div className="sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-canvas/90 px-3 py-2.5 backdrop-blur md:px-6">
          <button ref={menuButton} type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}
            aria-controls={open ? "mobile-menu" : undefined} aria-label={open ? "Close menu" : "Open menu"}
            className="rounded-lg p-2 hover:bg-surface md:hidden"><Menu className="size-5" /></button>
          <div className="min-w-0 flex-1">{header}</div>
        </div>
        <main id="main" className="min-w-0 px-3 py-5 md:px-6 md:py-6"><div className="mx-auto w-full min-w-0 max-w-[1440px]">{children}</div></main>
      </div>
    </div>
  );
}
