/** ZKTeco export parsing. Pure: bytes in, rows out. No DB, no I/O.
 *
 * Detects what the bytes ACTUALLY are, regardless of the file extension:
 *   OLE2 compound file or raw BIFF stream  -> xls_biff   (the AUGUST sample is raw BIFF)
 *   HTML table saved as .xls                -> xls_html
 *   text with tabs / commas                 -> tsv / csv
 *   ZIP (.xlsx)                             -> refused with advice: export CSV instead
 * Text encodings: UTF-8/UTF-16 with BOM or valid UTF-8 are trusted;
 * anything else is decoded with the fallback and flagged as uncertain. */
import { BiffError, isOle, isRawBiff, readFirstSheet } from "./biff.ts";

export type SourceKind = "csv" | "tsv" | "xls_biff" | "xls_html";
export type Direction = "in" | "out" | "break_out" | "break_in" | "ot_in" | "ot_out" | "unknown";

export class ParseError extends Error {}

export type ParsedRow = {
  rowNumber: number;
  cells: string[];
  status: "header" | "ok" | "error";
  error: string | null;
  enrollmentNo: string | null;
  name: string | null;
  department: string | null;
  localTs: string | null; // 'YYYY-MM-DDTHH:MM:SS' device wall clock, no zone
  statusLabel: string | null;
  direction: Direction | null;
  verify: string | null;
  location: string | null;
  workcode: string | null;
};

export type ParsedFile = { source: SourceKind; encoding: string; encodingCertain: boolean; rows: ParsedRow[] };

export const okRows = (pf: ParsedFile) => pf.rows.filter((r) => r.status === "ok");

const ALIASES: Record<string, string[]> = {
  enrollmentNo: ["no.", "ac-no.", "ac-no", "enroll no", "enrollno", "user id", "userid", "person id", "emp no."],
  name: ["name", "user name", "first name"],
  department: ["department", "dept.", "dept"],
  datetime: ["date/time", "datetime", "time", "check time", "punch time"],
  date: ["date"],
  clock: ["clock", "time only"],
  status: ["status", "state", "check type", "punch state", "in/out"],
  verify: ["verifycode", "verify code", "verify type", "verify mode", "verification"],
  location: ["location id", "machine id", "device id", "terminal"],
  workcode: ["workcode", "work code"],
};

// ------------------------------------------------------------ detection
export function detect(data: Uint8Array): SourceKind | "xlsx" {
  if (!data.length) throw new ParseError("the file is empty");
  if (isOle(data) || isRawBiff(data)) return "xls_biff";
  if (data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04) return "xlsx";
  const head = new TextDecoder("latin1").decode(data.subarray(0, 2048)).replace(/^\uFEFF|^\u00EF\u00BB\u00BF/, "").trimStart().toLowerCase();
  if (/^(<html|<!doctype|<table|<\?xml)/.test(head) || head.slice(0, 512).includes("<table")) return "xls_html";
  const nl = data.indexOf(0x0a);
  const firstLine = data.subarray(0, nl === -1 ? data.length : nl);
  return firstLine.includes(0x09) ? "tsv" : "csv";
}

export function decodeText(data: Uint8Array, fallback = "windows-1252"): { text: string; encoding: string; certain: boolean } {
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return { text: new TextDecoder("utf-8").decode(data.subarray(3)), encoding: "utf-8-sig", certain: true };
  if ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff))
    return { text: new TextDecoder(data[0] === 0xff ? "utf-16le" : "utf-16be").decode(data.subarray(2)), encoding: "utf-16", certain: true };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(data), encoding: "utf-8", certain: true };
  } catch {
    // Not UTF-8. GBK (Chinese-default firmware) vs Windows-1252 cannot be
    // told apart reliably: use the device's declared fallback and flag it.
    return { text: new TextDecoder(fallback).decode(data), encoding: fallback, certain: false };
  }
}

/** RFC 4180 CSV/TSV: quoted fields, doubled quotes, CRLF. */
export function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === sep) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const unentity = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()] ?? m);

export function parseHtmlTable(html: string): string[][] {
  const rows: string[][] = [];
  for (const tr of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((m) => unentity(m[1]!.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim());
    rows.push(cells);
  }
  return rows;
}

// ------------------------------------------------------------- datetime
type Tok = { tok: string; re: string; key?: "Y" | "y" | "M" | "D" | "H" | "h" | "m" | "s" | "A" };
const TOKENS: Tok[] = [
  { tok: "YYYY", re: "(\\d{4})", key: "Y" }, { tok: "YY", re: "(\\d{2})", key: "y" },
  { tok: "MM", re: "(\\d{1,2})", key: "M" }, { tok: "M", re: "(\\d{1,2})", key: "M" },
  { tok: "DD", re: "(\\d{1,2})", key: "D" }, { tok: "D", re: "(\\d{1,2})", key: "D" },
  { tok: "HH", re: "(\\d{1,2})", key: "H" }, { tok: "H", re: "(\\d{1,2})", key: "H" },
  { tok: "hh", re: "(\\d{1,2})", key: "h" }, { tok: "h", re: "(\\d{1,2})", key: "h" },
  { tok: "mm", re: "(\\d{2})", key: "m" }, { tok: "ss", re: "(\\d{2})", key: "s" },
  { tok: "AM", re: "(AM|PM|am|pm)", key: "A" },
];

/** 'M/D/YYYY h:mm:ss AM' -> matcher. Declared per device, never guessed per
 *  file: a file containing only days 1-12 cannot disambiguate D/M from M/D. */
export function compileFormat(fmt: string): (s: string) => string | null {
  let re = "^";
  const keys: Tok["key"][] = [];
  for (let i = 0; i < fmt.length;) {
    const t = TOKENS.find((x) => fmt.startsWith(x.tok, i));
    if (t) { re += t.re; keys.push(t.key); i += t.tok.length; }
    else { re += fmt[i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(" ", "\\s+"); i++; }
  }
  const rx = new RegExp(re + "$");
  return (s) => {
    const m = rx.exec(s.trim());
    if (!m) return null;
    const v: Record<string, string> = {};
    keys.forEach((k, idx) => { v[k!] = m[idx + 1]!; });
    const year = v.Y ? +v.Y : v.y ? 2000 + +v.y : NaN;
    let hour = v.H !== undefined ? +v.H : v.h !== undefined ? +v.h : 0;
    if (v.A) { if (hour < 1 || hour > 12) return null; hour = (hour % 12) + (v.A.toUpperCase() === "PM" ? 12 : 0); }
    return validTs(year, +v.M!, +v.D!, hour, +(v.m ?? 0), +(v.s ?? 0));
  };
}

function validTs(y: number, mo: number, d: number, h: number, mi: number, s: number): string | null {
  if (![y, mo, d, h, mi, s].every(Number.isFinite) || h > 23 || mi > 59 || s > 59) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null; // e.g. 31 June
  return dt.toISOString().slice(0, 19);
}

/** Excel serial date (1900 system), used when a cell holds a real date. */
function excelSerial(s: string): string | null {
  if (!/^\d{5}(\.\d+)?$/.test(s)) return null;
  const ms = Math.round((Number(s) - 25569) * 86400) * 1000;
  return new Date(ms).toISOString().slice(0, 19);
}

export const formatHasDayAndMonth = (fmt: string) => fmt.includes("D") && fmt.includes("M");

// ---------------------------------------------------------------- parse
export function headerMap(header: string[]): Record<string, number> {
  const norm = header.map((h) => h.trim().toLowerCase());
  const found: Record<string, number> = {};
  for (const [key, names] of Object.entries(ALIASES)) {
    const idx = norm.findIndex((h, i) => names.includes(h) && !Object.values(found).includes(i));
    if (idx !== -1) found[key] = idx;
  }
  return found;
}

/** Bytes -> raw table of strings (first row = header), whatever the format. */
export function readTable(data: Uint8Array, fallbackEncoding?: string): { source: SourceKind; encoding: string; certain: boolean; table: string[][] } {
  const kind = detect(data);
  if (kind === "xlsx") throw new ParseError("this is an .xlsx file; export from the device as CSV (or its default .xls) instead");
  let table: string[][], encoding: string, certain: boolean;
  if (kind === "xls_biff") {
    let sheet;
    try { sheet = readFirstSheet(data); } catch (e) {
      throw new ParseError(e instanceof BiffError ? `unreadable .xls: ${e.message}` : "unreadable .xls");
    }
    table = sheet.rows;
    certain = sheet.codepage !== null;
    encoding = sheet.codepage === null ? "iso-8859-1" : `codepage ${sheet.codepage}`; // no CODEPAGE record: like xlrd
  } else {
    const t = decodeText(data, fallbackEncoding);
    ({ encoding, certain } = t);
    table = kind === "xls_html" ? parseHtmlTable(t.text) : parseDelimited(t.text, kind === "tsv" ? "\t" : ",");
  }
  table = table.filter((r) => r.some((c) => c.trim()));
  if (!table.length) throw new ParseError("no rows found");
  return { source: kind, encoding, certain, table };
}

export function parse(data: Uint8Array, opts: { deviceFormat: string; statusLabelMap: Record<string, string>; fallbackEncoding?: string }): ParsedFile {
  const { source: kind, encoding, certain, table } = readTable(data, opts.fallbackEncoding);
  const cols = headerMap(table[0]!);
  const hasDt = "datetime" in cols || ("date" in cols && "clock" in cols);
  if (!("enrollmentNo" in cols) || !hasDt || !("status" in cols))
    throw new ParseError(`unrecognised header: ${JSON.stringify(table[0])} (need No., Date/Time and Status columns)`);

  const match = compileFormat(opts.deviceFormat);
  const labels = Object.fromEntries(Object.entries(opts.statusLabelMap).map(([k, v]) => [k.trim().toLowerCase(), v]));
  const cell = (row: string[], key: string) => {
    const i = cols[key];
    const v = i === undefined ? "" : (row[i] ?? "").trim();
    return v || null;
  };

  const rows: ParsedRow[] = [blank(0, table[0]!, "header")];
  table.slice(1).forEach((row, idx) => {
    const r = blank(idx + 1, row, "ok");
    try {
      r.enrollmentNo = cell(row, "enrollmentNo")?.replace(/^(\d+)\.0$/, "$1") ?? null;
      if (!r.enrollmentNo) throw new ParseError("missing enrollment number");
      const raw = cell(row, "datetime") ?? [cell(row, "date"), cell(row, "clock")].filter(Boolean).join(" ");
      if (!raw) throw new ParseError("missing date/time");
      r.localTs = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(raw) ? raw.replace(" ", "T") : match(raw) ?? excelSerial(raw);
      if (!r.localTs) throw new ParseError(`date/time "${raw}" does not match the device format`);
      r.statusLabel = cell(row, "status");
      if (!r.statusLabel) throw new ParseError("missing status");
      r.direction = (labels[r.statusLabel.toLowerCase()] as Direction | undefined) ?? "unknown";
      r.name = cell(row, "name");
      r.department = cell(row, "department");
      r.verify = cell(row, "verify");
      r.location = cell(row, "location");
      r.workcode = cell(row, "workcode");
    } catch (e) {
      r.status = "error";
      r.error = e instanceof Error ? e.message : String(e);
    }
    rows.push(r);
  });
  return { source: kind, encoding, encodingCertain: certain, rows };
}

function blank(n: number, cells: string[], status: ParsedRow["status"]): ParsedRow {
  return { rowNumber: n, cells, status, error: null, enrollmentNo: null, name: null, department: null, localTs: null,
           statusLabel: null, direction: null, verify: null, location: null, workcode: null };
}
