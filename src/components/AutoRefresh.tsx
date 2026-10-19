"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-renders the page while the worker is reading a file. */
export function AutoRefresh({ every = 4000 }: { every?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), every);
    return () => clearInterval(t);
  }, [router, every]);
  return <p role="status" className="text-sm text-ink-2">Reading the file. This page updates by itself.</p>;
}
