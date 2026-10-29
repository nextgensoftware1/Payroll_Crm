import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

const PUBLIC = ["/login", "/auth", "/api/cron"];  // cron routes check CRON_SECRET themselves

/** Refreshes the Supabase session cookie on every request and sends
 *  signed-out users to /login. Authorisation itself is NOT done here: the
 *  API and Postgres RLS decide what each person may see. */
export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (PUBLIC.some((p) => path === p || path.startsWith(`${p}/`))) {
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          toSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );
  // getClaims() verifies the JWT signature (JWKS) instead of trusting the cookie.
  // Skip this entirely for public routes so we do not pay the JWT verification cost
  // on every request to /login or /auth, while still protecting the rest of the app.
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  // Public files (login background, icons, fonts) must never require a session.
  matcher: ["/((?!_next/static|_next/image|images/|favicon|.*\\.(?:svg|png|jpe?g|webp|avif|gif|ico|woff2?|css|js|map)$).*)"],
};
