/** Reads device settings FROM the export itself, so HR doesn't have to:
 *  Location ID, In/Out labels and the date format. Pure, no DB.
 *
 *  Date format: every candidate is tried on every row. If exactly one
 *  family fits, it is used. If both day-first and month-first fit (every
 *  date has day 12 or below), that can't be decided from the data, so the
 *  caller's preference wins and `ambiguous` is reported. */
import { compileFormat, headerMap, ParseError, readTable } from "./parser.ts";

const CANDIDATES = [
  "M/D/YYYY h:mm:ss AM", "D/M/YYYY h:mm:ss AM", "M/D/YYYY h:mm AM", "D/M/YYYY h:mm AM",
  "M/D/YYYY H:mm:ss", "D/M/YYYY H:mm:ss", "M/D/YYYY H:mm", "D/M/YYYY H:mm",
  "YYYY-MM-DD HH:mm:ss", "YYYY/MM/DD HH:mm:ss", "YYYY-MM-DD HH:mm",
  "DD-MM-YYYY HH:mm:ss", "DD.MM.YYYY HH:mm:ss",
];

export type DetectedDevice = {
  locationCode: string | null;
  locationCodes: string[];
  inLabel: string | null;
  outLabel: string | null;
  labels: string[];
  datetimeFormat: string | null;
  ambiguous: boolean;
  rows: number;
};

export function detectDevice(data: Uint8Array, prefer: "month_first" | "day_first" = "month_first"): DetectedDevice {
  const { table } = readTable(data);
  const cols = headerMap(table[0]!);
  if (!("enrollmentNo" in cols) || !("status" in cols) || !("datetime" in cols || ("date" in cols && "clock" in cols)))
    throw new ParseError("this doesn't look like an attendance export (need No., Date/Time and Status columns)");
  const body = table.slice(1);
  const col = (r: string[], k: string) => (cols[k] === undefined ? "" : (r[cols[k]!] ?? "").trim());
  const stamps = body.map((r) => col(r, "datetime") || `${col(r, "date")} ${col(r, "clock")}`.trim()).filter(Boolean);

  const locationCodes = [...new Set(body.map((r) => col(r, "location")).filter(Boolean))].sort();
  const labels = [...new Set(body.map((r) => col(r, "status")).filter(Boolean))].sort();
  const inLabel = labels.find((l) => /(^|[^a-z])in$|check.?in|^in\b|c\/in/i.test(l)) ?? null;
  const outLabel = labels.find((l) => /(^|[^a-z])out$|check.?out|^out\b|c\/out/i.test(l)) ?? null;

  const isoLike = stamps.length > 0 && stamps.every((s) => /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(s));
  const fits = isoLike ? ["YYYY-MM-DD HH:mm:ss"] : CANDIDATES.filter((f) => {
    const m = compileFormat(f);
    return stamps.length > 0 && stamps.every((s) => m(s) !== null);
  });
  const monthFirst = fits.filter((f) => f.startsWith("M/"));
  const dayFirst = fits.filter((f) => f.startsWith("D/"));
  const ambiguous = monthFirst.length > 0 && dayFirst.length > 0;
  const datetimeFormat = ambiguous ? (prefer === "day_first" ? dayFirst[0]! : monthFirst[0]!) : fits[0] ?? null;

  return { locationCode: locationCodes.length === 1 ? locationCodes[0]! : null, locationCodes, inLabel, outLabel, labels,
           datetimeFormat, ambiguous, rows: body.length };
}
