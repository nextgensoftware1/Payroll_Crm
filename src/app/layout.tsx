import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { THEME_COOKIE } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Empire HR", template: "%s | Empire HR" },
  description: "Empire Networks HR, attendance and payroll control centre",
  icons: { icon: "/favicon.svg" },
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const t = (await cookies()).get(THEME_COOKIE)?.value;
  return (
    <html lang="en" data-theme={t === "light" || t === "dark" ? t : undefined}>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
