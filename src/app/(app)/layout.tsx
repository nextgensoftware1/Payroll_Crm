import { cookies, headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { HeaderBar } from "@/components/HeaderBar";
import { Shell } from "@/components/Shell";
import { signOut } from "@/app/auth/actions";
import { THEME_COOKIE, type Theme } from "@/lib/theme";
import { AppError } from "@/server/errors";
import { act, withSession } from "@/server/session";
import { listApprovals } from "@/server/services/approvals";
import { me } from "@/server/services/dashboard";
import { markAllRead, myNotifications } from "@/server/services/notifications";
import { monthChoices } from "@/server/services/reports";
import { createPerfTraceId, measure, runWithPerfTrace } from "@/server/perf";

async function markRead() {
  "use server";
  await act((c) => markAllRead(c));
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  let data;
  try {
    const traceId = (await headers()).get("x-empire-perf-trace") ?? createPerfTraceId();
    data = await runWithPerfTrace(traceId, () => withSession(async (c) =>
      measure("layout.page", async () => {
        const [person, approvals, notes, choices] = await Promise.all([
          me(c),
          listApprovals(c, { mine: true, limit: 200 }),
          myNotifications(c),
          c.isStaff ? monthChoices(c) : Promise.resolve({ latest: "", months: [] }),
        ]);
        return { me: person, pending: approvals.length, notes, months: choices.months, latest: choices.latest };
      })));
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof AppError && e.code === "no_access")
      return (
        <main className="grid min-h-dvh place-items-center px-4 text-center">
          <div className="max-w-md">
            <h1 className="text-xl font-bold">Your account has no access yet</h1>
            <p className="mt-2 text-ink-2">An Admin needs to link your login to your employee record. Contact HR.</p>
            <form action={signOut} method="post" className="mt-4"><button className="btn-quiet" type="submit">Sign out</button></form>
          </div>
        </main>);
    throw e;
  }
  const t = (await cookies()).get(THEME_COOKIE)?.value;
  const theme: Theme = t === "light" || t === "dark" ? t : "system";
  const name = data.me.employeeName ?? data.me.email ?? "Signed in";
  const staff = data.me.roles.includes("admin") || data.me.roles.includes("hr");
  const roleLabel = data.me.roles.includes("admin") ? "HR Admin" : data.me.roles.includes("hr") ? "HR" : data.me.roles.includes("manager") ? "Manager" : "Employee";
  return (
    <Shell sidebar={{ roles: data.me.roles, name, pending: data.pending, theme, signOut }}
      header={<Suspense fallback={null}><HeaderBar staff={staff} months={data.months} latest={data.latest} name={name} roleLabel={roleLabel}
        notes={data.notes.map((n) => ({ ...n, created_at: String(n.created_at) }))} markRead={markRead} /></Suspense>}>
      {children}
    </Shell>
  );
}
