import clsx from "clsx";

const TONE: Record<string, "ok" | "warn" | "bad" | "neutral" | "accent" | "review" | "info"> = {
  active: "ok", accepted: "ok", approved: "ok", resolved: "ok", accepted_as_is: "ok", promoted: "ok",
  uploaded: "accent", parsing: "accent", requested: "accent", under_review: "warn", pending: "warn",
  open: "warn", missing: "bad", rejected: "bad", parse_failed: "bad", expired: "bad",
  terminated: "neutral", resigned: "neutral", not_applicable: "neutral", proposed: "warn",
  present: "ok", late: "warn", absent: "bad", incomplete: "review", rest: "neutral", rest_day_work: "info", upcoming: "neutral", leave: "info", holiday: "info", not_employed: "neutral", excused: "info", unpaid_leave: "warn", draft: "accent", locked: "ok", superseded: "neutral",
};
const LABEL: Record<string, string> = {
  under_review: "In review", accepted_as_is: "Accepted as is", parse_failed: "Could not read",
  not_applicable: "Not applicable", uploaded: "Uploaded", parsing: "Reading file",
  present: "On time", incomplete: "Needs review", rest: "Rest day", rest_day_work: "Rest-day work", upcoming: "Not yet", not_employed: "Not employed", excused: "Late, excused", unpaid_leave: "Unpaid leave",
};

export function StatusChip({ status, className }: { status: string; className?: string }) {
  const tone = TONE[status] ?? "neutral";
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12.5px] font-semibold whitespace-nowrap",
        tone === "ok" && "bg-ok-soft text-ok",
        tone === "warn" && "bg-warn-soft text-warn",
        tone === "bad" && "bg-bad-soft text-bad",
        tone === "accent" && "bg-accent-soft text-accent",
        tone === "neutral" && "bg-surface-2 text-ink-2",
        tone === "review" && "bg-review-soft text-review",
        tone === "info" && "bg-info-soft text-info",
        className,
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {LABEL[status] ?? status.charAt(0).toUpperCase() + status.slice(1).replaceAll("_", " ")}
    </span>
  );
}
