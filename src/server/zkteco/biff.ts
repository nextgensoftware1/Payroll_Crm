/** Minimal legacy Excel (.xls) cell reader. Reads the FIRST worksheet only.
 *
 * Why not a spreadsheet library: the maintained SheetJS builds are not on
 * npm, and the npm copy (0.18.5) has known vulnerabilities. Attendance
 * exports only need cell text, so this reader supports exactly that:
 *
 *   BIFF2  LABEL 0x0004, NUMBER 0x0003, INTEGER 0x0002    (ZKTeco firmware writes these)
 *   BIFF3-8 LABEL 0x0204, LABELSST 0x00FD + SST 0x00FC/CONTINUE 0x003C,
 *           NUMBER 0x0203, RK 0x027E, MULRK 0x00BD
 *   Containers: raw BIFF stream (the AUGUST sample) or OLE2 compound file
 *   (real Excel 97-2003), unwrapped with SheetJS's small `cfb` package.
 *
 * Formulas, styles and dates-as-formats are deliberately not interpreted.
 * Numeric date cells come back as Excel serial numbers; the parser converts them. */
import CFB from "cfb";

export class BiffError extends Error {}

export type BiffSheet = { rows: string[][]; codepage: number | null };

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export function isOle(d: Uint8Array): boolean {
  return OLE_MAGIC.every((b, i) => d[i] === b);
}

export function isRawBiff(d: Uint8Array): boolean {
  return d.length >= 4 && d[0] === 0x09 && [0x00, 0x02, 0x04, 0x08].includes(d[1]!);
}

function workbookStream(d: Uint8Array): Uint8Array {
  if (!isOle(d)) return d;
  let container;
  try {
    container = CFB.read(Buffer.from(d), { type: "buffer" });
  } catch {
    throw new BiffError("the .xls container is damaged");
  }
  const entry = CFB.find(container, "Workbook") ?? CFB.find(container, "Book");
  if (!entry?.content) throw new BiffError("no workbook stream in the .xls file");
  return new Uint8Array(entry.content as ArrayLike<number>);
}

const CODEPAGES: Record<number, string> = {
  1200: "utf-16le", 1252: "windows-1252", 1250: "windows-1250", 1251: "windows-1251", 1256: "windows-1256",
  936: "gbk", 950: "big5", 932: "shift_jis", 65001: "utf-8", 367: "windows-1252", 32769: "windows-1252",
};

function rk(v: number): number {
  let n: number;
  if (v & 2) {
    n = v >> 2; // 30-bit signed integer
  } else {
    const buf = new DataView(new ArrayBuffer(8));
    buf.setUint32(0, 0, true);
    buf.setUint32(4, v & 0xfffffffc, true);
    n = buf.getFloat64(0, true);
  }
  return v & 1 ? n / 100 : n;
}

const numText = (n: number) => (Number.isInteger(n) ? String(n) : String(n));

/** Cursor over SST + CONTINUE segments: strings may be split across records,
 *  and each continuation of character data starts with a fresh flags byte. */
class SegCursor {
  private seg = 0;
  private pos = 0;
  private readonly segs: Uint8Array[];
  constructor(segs: Uint8Array[]) {
    this.segs = segs;
  }
  private ensure() {
    while (this.seg < this.segs.length && this.pos >= this.segs[this.seg]!.length) { this.seg++; this.pos = 0; }
    if (this.seg >= this.segs.length) throw new BiffError("SST ended early");
  }
  u8() { this.ensure(); return this.segs[this.seg]![this.pos++]!; }
  u16() { return this.u8() | (this.u8() << 8); }
  u32() { return (this.u16() | (this.u16() << 16)) >>> 0; }
  skip(n: number) { for (let i = 0; i < n; i++) this.u8(); }
  remainingInSeg() { return this.segs[this.seg] ? this.segs[this.seg]!.length - this.pos : 0; }
  atSegEnd() { return this.remainingInSeg() === 0; }
  chars(count: number, wide: boolean): string {
    let out = "";
    while (count > 0) {
      if (this.atSegEnd()) { this.seg++; this.pos = 0; wide = (this.u8() & 1) === 1; continue; }
      const seg = this.segs[this.seg]!;
      const avail = wide ? Math.floor(this.remainingInSeg() / 2) : this.remainingInSeg();
      const take = Math.min(count, avail);
      const slice = seg.subarray(this.pos, this.pos + take * (wide ? 2 : 1));
      out += new TextDecoder(wide ? "utf-16le" : "latin1").decode(slice);
      this.pos += take * (wide ? 2 : 1);
      count -= take;
    }
    return out;
  }
}

function readSst(segs: Uint8Array[]): string[] {
  const c = new SegCursor(segs);
  c.u32(); // total references
  const unique = c.u32();
  const out: string[] = [];
  for (let i = 0; i < unique; i++) {
    const cch = c.u16();
    const flags = c.u8();
    const runs = flags & 0x08 ? c.u16() : 0;
    const ext = flags & 0x04 ? c.u32() : 0;
    out.push(c.chars(cch, (flags & 1) === 1));
    c.skip(runs * 4 + ext);
  }
  return out;
}

export function readFirstSheet(data: Uint8Array): BiffSheet {
  const s = workbookStream(data);
  const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
  const cells = new Map<number, Map<number, string>>();
  let codepage: number | null = null;
  let sst: string[] = [];
  let sstSegs: Uint8Array[] | null = null;
  let biff8 = false;
  let inSheet = false;
  let maxCol = -1;

  const decode8 = (bytes: Uint8Array) => new TextDecoder(CODEPAGES[codepage ?? 0] ?? "latin1").decode(bytes);
  const put = (r: number, c: number, v: string) => {
    if (!cells.has(r)) cells.set(r, new Map());
    cells.get(r)!.set(c, v);
    if (c > maxCol) maxCol = c;
  };

  let i = 0;
  while (i + 4 <= s.length) {
    const type = dv.getUint16(i, true);
    const len = dv.getUint16(i + 2, true);
    const p = i + 4;
    if (p + len > s.length) throw new BiffError("record runs past end of file");
    const rec = s.subarray(p, p + len);
    i = p + len;

    if (sstSegs && type === 0x003c) { sstSegs.push(rec); continue; }
    if (sstSegs) { sst = readSst(sstSegs); sstSegs = null; }

    switch (type) {
      case 0x0009: case 0x0209: case 0x0409: case 0x0809: {
        const version = len >= 2 ? dv.getUint16(p, true) : 0;
        const kind = len >= 4 ? dv.getUint16(p + 2, true) : 0x0010;
        if (type === 0x0809 && version === 0x0600) biff8 = true;
        // first worksheet substream (0x0010); BIFF2-4 streams are single worksheets
        if (kind === 0x0010 || type !== 0x0809) inSheet = true;
        break;
      }
      case 0x000a: // EOF
        if (inSheet) return finish();
        break;
      case 0x0042: codepage = dv.getUint16(p, true); break;
      case 0x00fc: sstSegs = [rec]; break;
      case 0x0004: if (inSheet) { // BIFF2 LABEL: row, col, 3 attr bytes, u8 length, 8-bit chars
        const n = rec[7]!;
        put(dv.getUint16(p, true), dv.getUint16(p + 2, true), decode8(rec.subarray(8, 8 + n)));
      } break;
      case 0x0204: if (inSheet) {
        const n = dv.getUint16(p + 6, true);
        if (biff8) {
          const wide = (rec[8]! & 1) === 1;
          const bytes = rec.subarray(9, 9 + n * (wide ? 2 : 1));
          put(dv.getUint16(p, true), dv.getUint16(p + 2, true), new TextDecoder(wide ? "utf-16le" : "latin1").decode(bytes));
        } else {
          put(dv.getUint16(p, true), dv.getUint16(p + 2, true), decode8(rec.subarray(8, 8 + n)));
        }
      } break;
      case 0x00fd: if (inSheet) put(dv.getUint16(p, true), dv.getUint16(p + 2, true), sst[dv.getUint32(p + 6, true)] ?? ""); break;
      case 0x0003: if (inSheet) put(dv.getUint16(p, true), dv.getUint16(p + 2, true), numText(dv.getFloat64(p + 7, true))); break;
      case 0x0002: if (inSheet) put(dv.getUint16(p, true), dv.getUint16(p + 2, true), String(dv.getUint16(p + 7, true))); break;
      case 0x0203: if (inSheet) put(dv.getUint16(p, true), dv.getUint16(p + 2, true), numText(dv.getFloat64(p + 6, true))); break;
      case 0x027e: if (inSheet) put(dv.getUint16(p, true), dv.getUint16(p + 2, true), numText(rk(dv.getUint32(p + 6, true)))); break;
      case 0x00bd: if (inSheet) {
        const row = dv.getUint16(p, true);
        const first = dv.getUint16(p + 2, true);
        const count = (len - 6) / 6;
        for (let k = 0; k < count; k++) put(row, first + k, numText(rk(dv.getUint32(p + 4 + k * 6 + 2, true))));
      } break;
      default: break;
    }
  }
  return finish();

  function finish(): BiffSheet {
    const rowIdx = [...cells.keys()].sort((a, b) => a - b);
    const rows = rowIdx.map((r) => Array.from({ length: maxCol + 1 }, (_, c) => cells.get(r)!.get(c) ?? ""));
    return { rows, codepage };
  }
}
