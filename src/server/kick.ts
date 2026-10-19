import "server-only";
import { after } from "next/server";
import { runImportJobs } from "./jobs/attendance-import.ts";
import { serviceStorage } from "./storage.ts";

/** Start background processing after the response is sent (never blocks the page).
 *  Overlapping runs are safe: jobs claim work with FOR UPDATE SKIP LOCKED. */
export function processImportsInBackground(): void {
  after(async () => {
    try { await runImportJobs(serviceStorage(), 50_000); }
    catch (e) { console.error("[empire-hr] background import failed; the cron job will retry", e); }
  });
}
