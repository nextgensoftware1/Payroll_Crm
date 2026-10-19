"use client";
import { Moon, Sun } from "lucide-react";
import { useState } from "react";
import { THEME_COOKIE, type Theme } from "@/lib/theme";

/** Light / dark switch in the sidebar. Remembered in a cookie so the server renders the right theme (no flash). */
export function ThemeSwitch({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useState<Theme>(initial);
  function pick(t: Theme) {
    setTheme(t);
    document.cookie = `${THEME_COOKIE}=${t}; path=/; max-age=31536000; samesite=lax`;
    if (t === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  }
  const opt = (t: Theme, label: string, Icon: typeof Sun) => (
    <button type="button" onClick={() => pick(t)} aria-pressed={theme === t}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[13px] font-medium ${theme === t ? "bg-accent text-white" : "text-sidebar-ink hover:text-white"}`}>
      <Icon aria-hidden className="size-4" />{label}
    </button>);
  return (
    <div role="group" aria-label="Theme" className="flex gap-1 rounded-lg bg-white/5 p-1">
      {opt("light", "Light", Sun)}{opt("dark", "Dark", Moon)}
    </div>
  );
}
