"use client";
import { Menu } from "lucide-react";
import { useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import type { Theme } from "@/lib/theme";
import type { Role } from "@/lib/types";

/** App frame: fixed navy sidebar on desktop, slide-out drawer on mobile. */
export function Shell({ sidebar, header, children }: {
  sidebar: { roles: Role[]; name: string; pending: number; theme: Theme; signOut: () => Promise<void> };
  header: React.ReactNode; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[248px_1fr]">
      <aside className="hidden bg-sidebar md:block"><div className="sticky top-0 h-dvh"><Sidebar {...sidebar} /></div></aside>
      {open ? (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[272px]"><Sidebar {...sidebar} onNavigate={() => setOpen(false)} /></aside>
        </div>) : null}
      <div className="min-w-0">
        <div className="sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-canvas/90 px-3 py-2.5 backdrop-blur md:px-6">
          <button type="button" onClick={() => setOpen(true)} aria-label="Open menu" className="rounded-lg p-2 hover:bg-surface md:hidden"><Menu className="size-5" /></button>
          <div className="min-w-0 flex-1">{header}</div>
        </div>
        <main id="main" className="px-3 py-5 md:px-6 md:py-6"><div className="mx-auto max-w-[1440px]">{children}</div></main>
      </div>
    </div>
  );
}
