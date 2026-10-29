import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

const PUBLIC = ["/login", "/auth", "/api/cron"];  // cron routes check CRON_SECRET themselves

/** Refreshes the Supabase session cookie on every request and sends
 *  signed-out users to /login. Authorisation itself is NOT done here: the
 *  API and Postgres RLS decide what each person may see. */
export async function proxy(request: NextRequest) {
  const perfEnabled = process.env.HR_PERF_LOG === "1";
  const mode = process.env.NODE_ENV ?? "unknown";
  const started = performance.now();
  const traceId = globalThis.crypto.randomUUID();
  const path = request.nextUrl.pathname;
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-empire-perf-trace", traceId);
  if (PUBLIC.some((p) => path === p || path.startsWith(`${p}/`))) {
    if (perfEnabled) console.info(`[empire-hr:perf:proxy] trace=${traceId} mode=${mode} public-route total=${Math.round(performance.now() - started)}ms`);
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  let response = NextResponse.next({ request: { headers: requestHeaders } });
  const clientStarted = performance.now();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          toSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request: { headers: requestHeaders } });
          toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );
  const clientMs = Math.round(performance.now() - clientStarted);
  // getClaims() verifies the JWT signature (JWKS) instead of trusting the cookie.
  // Skip this entirely for public routes so we do not pay the JWT verification cost
  // on every request to /login or /auth, while still protecting the rest of the app.
  const claimsStarted = performance.now();
  const { data } = await supabase.auth.getClaims();
  const claimsMs = Math.round(performance.now() - claimsStarted);
  if (!data?.claims) {
    if (perfEnabled) console.info(`[empire-hr:perf:proxy] trace=${traceId} mode=${mode} protected-route client=${clientMs}ms claims=${claimsMs}ms total=${Math.round(performance.now() - started)}ms result=no_claims`);
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);
    const redirect = NextResponse.redirect(url);
    redirect.headers.set("x-empire-perf-trace", traceId);
    return redirect;
  }
  if (perfEnabled) console.info(`[empire-hr:perf:proxy] trace=${traceId} mode=${mode} protected-route client=${clientMs}ms claims=${claimsMs}ms total=${Math.round(performance.now() - started)}ms result=claims`);
  response.headers.set("x-empire-perf-trace", traceId);
  return response;
}

export const config = {
  // Public files (login background, icons, fonts) must never require a session.
  matcher: ["/((?!_next/static|_next/image|images/|favicon|.*\\.(?:svg|png|jpe?g|webp|avif|gif|ico|woff2?|css|js|map)$).*)"],
};
