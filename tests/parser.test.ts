/** Parser + review rules against the REAL August export and synthetic
 *  variants of what ZKTeco devices produce. No database. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readFirstSheet } from "../src/server/zkteco/biff.ts";
import { detectFlags } from "../src/server/zkteco/flags.ts";
import { compileFormat, detect, okRows, parse, ParseError } from "../src/server/zkteco/parser.ts";
import { SAMPLE } from "./harness.ts";

const FMT = "M/D/YYYY h:mm:ss AM", LABELS = { "C/In": "in", "C/Out": "out" };
const HEADER = ["Department", "Name", "No.", "Date/Time", "Status", "Location ID", "ID Number", "Workcode", "VerifyCode", "CardNo"];
const opts = { deviceFormat: FMT, statusLabelMap: LABELS };
const flagOpts = { mappings: [], deviceFormat: FMT, nearDuplicateSeconds: 60, claimedPeriod: null, nowLocal: "2026-10-16T12:00:00" };
const csv = (rows: string[][], sep = ",") => new TextEncoder().encode([HEADER, ...rows].map((r) => r.join(sep)).join("\n"));
const count = (xs: { kind: string }[]) => xs.reduce<Record<string, number>>((a, f) => ({ ...a, [f.kind]: (a[f.kind] ?? 0) + 1 }), {});

test("sample is a raw BIFF stream, not HTML", () => assert.equal(detect(SAMPLE), "xls_biff"));

test("sample parses every row, cells verbatim", () => {
  const pf = parse(SAMPLE, opts);
  assert.equal(pf.rows.length, 477);
  assert.equal(okRows(pf).length, 476);
  const first = okRows(pf)[0]!;
  assert.equal(first.cells[3], "8/1/2026 3:06:51 AM");
  assert.equal(first.localTs, "2026-08-01T03:06:51");
  assert.deepEqual([first.enrollmentNo, first.name, first.statusLabel, first.direction], ["1", "Moon", "C/Out", "out"]);
  assert.equal(pf.encodingCertain, false); // BIFF without CODEPAGE record
});

test("review flags match the manual analysis of the sample", () => {
  const flags = detectFlags(parse(SAMPLE, opts), flagOpts);
  const c = count(flags);
  assert.equal(c.unknown_enrollment, 15);  // one per person, never per row
  assert.equal(c.near_duplicate, 11);      // 1-44 s double presses
  assert.equal(c.direction_conflict, 1);   // one summary...
  assert.equal(flags.find((f) => f.kind === "direction_conflict")!.details.count, 82); // ...of 82
  assert.equal(c.encoding_uncertain, 1);
});

test("a mapped person with a different name is flagged, never guessed", () => {
  const pf = parse(SAMPLE, opts);
  const flags = detectFlags(pf, { ...flagOpts, mappings: [{ enrollmentNo: "1", employeeId: "x", expectedName: "Mooner Khan", validFrom: null, validTo: null }] });
  assert.ok(!flags.some((f) => f.kind === "unknown_enrollment" && f.details.enrollment_no === "1"));
  assert.ok(flags.some((f) => f.kind === "name_mismatch" && f.details.enrollment_no === "1"));
});

test("real Excel 97 (OLE2, BIFF8, shared strings, Unicode) is read", () => {
  const data = new Uint8Array(readFileSync(path.join(import.meta.dirname, "fixtures/excel97_biff8.xls")));
  const pf = parse(data, opts);
  assert.equal(pf.source, "xls_biff");
  assert.equal(pf.encodingCertain, true);
  assert.deepEqual(okRows(pf).map((r) => r.name?.slice(0, 9)), ["Zoë Ahmed", "عائشہ", "LongLongL", "Num"]);
  assert.equal(okRows(pf)[3]!.enrollmentNo, "8"); // numeric cell
  assert.equal(readFirstSheet(data).rows[0]![3], "Date/Time");
});

test("HTML table saved as .xls is detected", () => {
  const html = `<html><table><tr>${HEADER.map((h) => `<td>${h}</td>`).join("")}</tr>
    <tr><td>Co</td><td>Moon &amp; Co</td><td>1</td><td>8/1/2026 3:06:51 AM</td><td>C/Out</td><td>101</td><td></td><td>0</td><td>FP</td><td></td></tr></table></html>`;
  const pf = parse(new TextEncoder().encode(html), opts);
  assert.equal(pf.source, "xls_html");
  assert.equal(okRows(pf)[0]!.name, "Moon & Co");
});

test("TSV and non-UTF-8 CSV", () => {
  const row = ["Co", "Zoë", "5", "8/2/2026 6:00:00 PM", "C/In", "101", "", "0", "FP", ""];
  assert.equal(parse(csv([row], "\t"), opts).source, "tsv");
  const cp1252 = Uint8Array.from([...[HEADER, row].map((r) => r.join(",")).join("\n")].map((ch) => ch === "ë" ? 0xeb : ch.charCodeAt(0)));
  const pf = parse(cp1252, opts);
  assert.equal(pf.encodingCertain, false);
  assert.equal(okRows(pf)[0]!.name, "Zoë");
});

test("quoted CSV fields with commas", () => {
  const pf = parse(csv([["Co", '"Khan, Ali"', "9", "8/2/2026 6:00:00 PM", "C/In", "101", "", "0", "FP", ""]]), opts);
  assert.equal(okRows(pf)[0]!.name, "Khan, Ali");
});

test("day/month ambiguity is flagged, not guessed", () => {
  const rows = [1, 5, 12].map((d) => ["Co", "A", "1", `8/${d}/2026 9:00:00 AM`, "C/In", "101", "", "0", "FP", ""]);
  assert.ok(detectFlags(parse(csv(rows), opts), flagOpts).some((f) => f.kind === "ambiguous_date"));
});

test("bad rows are kept as errors, not dropped; impossible dates rejected", () => {
  const pf = parse(csv([
    ["Co", "A", "1", "not a date", "C/In", "101", "", "0", "FP", ""],
    ["Co", "B", "", "8/2/2026 9:00:00 AM", "C/In", "101", "", "0", "FP", ""],
    ["Co", "C", "3", "6/31/2026 9:00:00 AM", "C/In", "101", "", "0", "FP", ""]]), opts);
  assert.deepEqual(pf.rows.map((r) => r.status), ["header", "error", "error", "error"]);
});

test("unknown header and .xlsx are refused with advice", () => {
  assert.throws(() => parse(new TextEncoder().encode("foo,bar\n1,2\n"), opts), ParseError);
  assert.throws(() => parse(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), opts), /export from the device as CSV/);
});

test("format compiler", () => {
  assert.equal(compileFormat("M/D/YYYY h:mm:ss AM")("12/31/2026 12:05:00 AM"), "2026-12-31T00:05:00");
  assert.equal(compileFormat("DD-MM-YYYY HH:mm")("05-08-2026 17:30"), "2026-08-05T17:30:00");
  assert.equal(compileFormat("M/D/YYYY h:mm:ss AM")("13/01/2026 1:00:00 AM"), null);
});
