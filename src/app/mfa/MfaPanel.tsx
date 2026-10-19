"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Step = { kind: "loading" } | { kind: "enroll"; factorId: string; qr: string; secret: string }
  | { kind: "verify"; factorId: string } | { kind: "error"; message: string };

/** HR and Admin must use an authenticator app (Supabase TOTP). The API
 *  refuses staff tokens whose assurance level is not aal2. */
export function MfaPanel() {
  const supabase = createClient();
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (error) return setStep({ kind: "error", message: error.message });
      const verified = data.totp.find((f) => f.status === "verified");
      if (verified) return setStep({ kind: "verify", factorId: verified.id });
      const enrolled = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: `Empire HR ${Date.now()}` });
      if (enrolled.error) return setStep({ kind: "error", message: enrolled.error.message });
      setStep({ kind: "enroll", factorId: enrolled.data.id, qr: enrolled.data.totp.qr_code, secret: enrolled.data.totp.secret });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (step.kind !== "enroll" && step.kind !== "verify") return;
    setBusy(true);
    setMsg(null);
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: step.factorId, code: code.trim() });
    setBusy(false);
    if (error) return setMsg("That code didn't work. Codes change every 30 seconds; try the current one.");
    router.replace("/");
    router.refresh();
  }

  if (step.kind === "loading") return <p className="text-ink-2">Checking your sign-in…</p>;
  if (step.kind === "error") return <p role="alert" className="text-bad">{step.message}</p>;
  return (
    <form onSubmit={submit} className="space-y-4">
      {step.kind === "enroll" ? (
        <div className="space-y-3">
          <p className="text-[15px]">Scan this with Google Authenticator, Microsoft Authenticator or 1Password.</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={step.qr} alt="QR code for your authenticator app" className="size-44 rounded-md bg-white p-2" />
          <p className="text-[13px] text-ink-3">Can't scan? Enter this key: <code className="break-all">{step.secret}</code></p>
        </div>
      ) : (
        <p className="text-[15px]">Enter the 6-digit code from your authenticator app.</p>
      )}
      <div>
        <label className="label" htmlFor="code">Code</label>
        <input id="code" className="field max-w-40 text-lg tracking-[0.3em]" inputMode="numeric" autoComplete="one-time-code"
          pattern="[0-9]{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required />
      </div>
      {msg ? <p role="alert" className="text-sm text-bad">{msg}</p> : null}
      <button className="btn-primary" disabled={busy}>{busy ? "Checking…" : "Verify"}</button>
    </form>
  );
}
