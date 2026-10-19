"use client";
import { Copy, Eye, EyeOff, Sparkles } from "lucide-react";
import { useState } from "react";

/** Temporary-password input with show/hide, a strong generator and copy. */
export function PasswordField({ id, name, label }: { id: string; name: string; label: string }) {
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  function generate() {
    // 14 chars from an alphabet without look-alikes (0/O, 1/l/I); always upper, lower and a digit
    const A = "ABCDEFGHJKLMNPQRSTUVWXYZ", a = "abcdefghijkmnpqrstuvwxyz", n = "23456789", all = A + a + n;
    const r = crypto.getRandomValues(new Uint32Array(14));
    const chars = Array.from(r, (x, i) => (i === 0 ? A : i === 1 ? a : i === 2 ? n : all)[x % (i < 3 ? [A, a, n][i]!.length : all.length)]!);
    for (let i = chars.length - 1; i > 0; i--) { const j = r[i]! % (i + 1); [chars[i], chars[j]] = [chars[j]!, chars[i]!]; }
    setValue(chars.join("")); setShow(true); setCopied(false);
  }
  return (
    <div>
      <label className="label" htmlFor={id}>{label}</label>
      <div className="flex gap-1.5">
        <div className="relative flex-1">
          <input id={id} name={name} className="field pr-9 font-mono text-[13.5px]" type={show ? "text" : "password"} value={value}
            onChange={(e) => { setValue(e.target.value); setCopied(false); }} autoComplete="new-password" minLength={12} required />
          <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide password" : "Show password"}
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-ink-3 hover:text-ink">{show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button>
        </div>
        <button type="button" onClick={generate} className="btn-quiet px-2.5" title="Generate a strong password"><Sparkles aria-hidden className="size-4" />Generate</button>
        <button type="button" disabled={!value} onClick={async () => { await navigator.clipboard.writeText(value); setCopied(true); }}
          className="btn-quiet px-2.5" aria-label="Copy password"><Copy aria-hidden className="size-4" />{copied ? "Copied" : ""}</button>
      </div>
      <p className="mt-1 text-[12.5px] text-ink-3">At least 12 characters with upper- and lower-case letters and a number. They must change it at first sign-in.</p>
    </div>);
}
