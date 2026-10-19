import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** Supabase email links (password reset) land here; exchange the one-time code for a session. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next");
  const safeNext = next && /^\/[A-Za-z0-9/_-]*$/.test(next) ? next : "/";
  if (code) {
    const { error } = await (await createClient()).auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(safeNext, url.origin));
  }
  return NextResponse.redirect(new URL("/auth/forgot?expired=1", url.origin));
}
