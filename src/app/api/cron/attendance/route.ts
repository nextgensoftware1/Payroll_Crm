import { NextResponse } from "next/server";
import { runImportJobs } from "@/server/jobs/attendance-import";
import { serviceStorage } from "@/server/storage";
import { cronAuthorized } from "../guard";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Safety net for the after() trigger: parses waiting uploads and records
 *  punches for decided batches. Safe to overlap (SKIP LOCKED). */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  const done = await runImportJobs(serviceStorage(), 50_000);
  return NextResponse.json(done);
}
