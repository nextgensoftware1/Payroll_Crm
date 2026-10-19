/** Import review rules. Pure: parsed rows + mappings in, flags out.
 *  None of these discard or alter a punch; they put questions in front of
 *  HR. Per-person issues are one flag per person; noisy patterns (In/Out
 *  conflicts, out-of-period rows) are one batch-level flag with examples. */
import { formatHasDayAndMonth, okRows, type ParsedFile, type ParsedRow } from "./parser.ts";

export type Mapping = { enrollmentNo: string; employeeId: string; expectedName: string; validFrom: string | null; validTo: string | null };
export type Flag = { kind: string; rowNumber: number | null; details: Record<string, unknown> };

const covers = (m: Mapping, d: string) => (!m.validFrom || d >= m.validFrom) && (!m.validTo || d < m.validTo);
export const normName = (s: string | null) => (s ?? "").toLocaleLowerCase("en").split(/\s+/).filter(Boolean).join(" ");
const epoch = (ts: string) => Date.parse(`${ts}Z`); // wall-clock arithmetic only

export function detectFlags(pf: ParsedFile, o: {
  mappings: Mapping[]; deviceFormat: string; nearDuplicateSeconds: number;
  claimedPeriod: [string, string] | null; nowLocal: string; maxExamples?: number;
}): Flag[] {
  const max = o.maxExamples ?? 10;
  const flags: Flag[] = [];
  const rows = okRows(pf);
  const byPerson = new Map<string, ParsedRow[]>();
  for (const r of rows) byPerson.set(r.enrollmentNo!, [...(byPerson.get(r.enrollmentNo!) ?? []), r]);
  const maps = new Map<string, Mapping[]>();
  for (const m of o.mappings) maps.set(m.enrollmentNo, [...(maps.get(m.enrollmentNo) ?? []), m]);

  if (!pf.encodingCertain)
    flags.push({ kind: "encoding_uncertain", rowNumber: null, details: { detected: pf.encoding, source: pf.source,
      advice: "Check that names with non-English characters look right before accepting." } });

  if (formatHasDayAndMonth(o.deviceFormat) && rows.length && rows.every((r) => Number(r.localTs!.slice(8, 10)) <= 12))
    flags.push({ kind: "ambiguous_date", rowNumber: null, details: { declared_format: o.deviceFormat,
      reason: "Every date in this file has day 12 or below, so day/month order cannot be confirmed from the data." } });

  let directionCount = 0;
  const directionExamples: unknown[] = [];
  for (const [enrol, prs] of byPerson) {
    prs.sort((a, b) => a.localTs!.localeCompare(b.localTs!));
    const first = prs[0]!;
    const ms = maps.get(enrol) ?? [];
    const uncovered = prs.filter((r) => !ms.some((m) => covers(m, r.localTs!.slice(0, 10))));
    if (uncovered.length)
      flags.push({ kind: "unknown_enrollment", rowNumber: uncovered[0]!.rowNumber, details: {
        enrollment_no: enrol, name_seen: first.name, rows: uncovered.length,
        first: uncovered[0]!.localTs, last: uncovered.at(-1)!.localTs,
        advice: "Propose a punch mapping for this enrollment number. Names are never used to match." } });
    for (const m of ms.filter((m) => prs.some((r) => covers(m, r.localTs!.slice(0, 10))))) {
      const seen = [...new Set(prs.map((r) => normName(r.name)).filter(Boolean))].sort();
      if (seen.length && !seen.includes(normName(m.expectedName)))
        flags.push({ kind: "name_mismatch", rowNumber: first.rowNumber, details: {
          enrollment_no: enrol, name_seen: seen, expected_name: m.expectedName, employee_id: m.employeeId } });
    }
    for (let k = 1; k < prs.length; k++) {
      const a = prs[k - 1]!, b = prs[k]!;
      const gap = (epoch(b.localTs!) - epoch(a.localTs!)) / 1000;
      if (gap >= 0 && gap <= o.nearDuplicateSeconds)
        flags.push({ kind: "near_duplicate", rowNumber: b.rowNumber, details: {
          enrollment_no: enrol, name_seen: first.name, seconds_apart: gap, first_row: a.rowNumber, second_row: b.rowNumber,
          first: `${a.localTs} ${a.statusLabel}`, second: `${b.localTs} ${b.statusLabel}`,
          advice: "Both punches are kept. Confirm whether this is one double press." } });
      if (a.statusLabel === b.statusLabel) {
        directionCount++;
        if (directionExamples.length < max)
          directionExamples.push({ enrollment_no: enrol, name_seen: first.name, rows: [a.rowNumber, b.rowNumber], label: a.statusLabel });
      }
    }
  }
  if (directionCount)
    flags.push({ kind: "direction_conflict", rowNumber: null, details: { count: directionCount, examples: directionExamples,
      advice: "In/Out labels are stored as recorded but are not trusted; attendance pairs punches by order and shift." } });

  if (o.claimedPeriod) {
    const [start, end] = o.claimedPeriod;
    const outside = rows.filter((r) => { const d = r.localTs!.slice(0, 10); return d < start || d > end; });
    if (outside.length)
      flags.push({ kind: "outside_claimed_period", rowNumber: null, details: { count: outside.length, claimed: [start, end],
        examples: outside.slice(0, max).map((r) => ({ row: r.rowNumber, at: r.localTs })) } });
  }

  const horizon = new Date(epoch(o.nowLocal) + 5 * 60_000).toISOString().slice(0, 19);
  for (const r of rows)
    if (r.localTs! > horizon)
      flags.push({ kind: "future_timestamp", rowNumber: r.rowNumber, details: { at: r.localTs,
        advice: "The device clock may be wrong; consider a clock adjustment." } });
  return flags;
}
