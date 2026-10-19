import { NextResponse } from "next/server";
import { today } from "@/server/context";
import { runLifecycleAlerts } from "@/server/jobs/lifecycle-alerts";
import { cronAuthorized } from "../guard";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Nightly probation/contract alerts (idempotent; never changes any record). */
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ created: await runLifecycleAlerts(today()) });
}
