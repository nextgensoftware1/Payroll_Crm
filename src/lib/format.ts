const TZ = "Asia/Karachi";

export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso.slice(0, 10)}T00:00:00Z`)) : "—";

export const fmtDateTime = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ }).format(new Date(iso)) : "—";

/** Device-local wall clock values (no zone): show as-is. */
export const fmtLocal = (naive: string) => {
  const [d, t] = naive.split("T");
  return `${fmtDate(d)} ${t?.slice(0, 5) ?? ""}`;
};

export const humanize = (s: string) => s.replaceAll("_", " ").replace(/^\w/, (c) => c.toUpperCase());

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-PK")} ${n === 1 ? one : many}`;

/** Money is stored in paisa (integers). */
export const pkr = (paisa: number | null | undefined, decimals = 0) =>
  paisa === null || paisa === undefined ? "—" : (paisa / 100).toLocaleString("en-PK", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
export const clock = (naive: string | null) => (naive ? naive.slice(11, 16) : "—");
export const hours = (min: number | null) => (min === null ? "—" : `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`);
export const WEEKDAY = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
