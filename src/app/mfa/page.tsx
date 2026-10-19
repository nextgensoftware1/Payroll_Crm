import type { Metadata } from "next";
import { AuthFrame } from "@/components/AuthFrame";
import { MfaPanel } from "./MfaPanel";

export const metadata: Metadata = { title: "Verify it's you" };

export default function MfaPage() {
  return (
    <AuthFrame>
      <h1 className="text-[26px] font-semibold">Authenticator verification</h1>
      <p className="mt-1 mb-6 text-ink-3">HR and Admin accounts handle salary and identity data, so they need a second step.</p>
      <div className="panel p-6"><MfaPanel /></div>
          </AuthFrame>
  );
}
