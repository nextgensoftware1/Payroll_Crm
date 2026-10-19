import "server-only";
import { timingSafeEqual } from "node:crypto";
import { config } from "@/server/config";

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Constant-time check. */
export function cronAuthorized(req: Request): boolean {
  const secret = config().CRON_SECRET;
  if (!secret) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}
