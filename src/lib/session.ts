import type { APIContext } from 'astro';

/**
 * Session lifetime helpers.
 *
 * The single source of truth for the session TTL lives in astro.config.mjs
 * (`SESSION_TTL_SECONDS`); keep the constant below in sync with it. This
 * module exists so runtime code (middleware, auth callbacks) can stay
 * consistent with that config without importing it.
 */

/** Must match SESSION_TTL_SECONDS in astro.config.mjs (one year, KV bound). */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 365;

/**
 * Browsers cap any cookie at 400 days (RFC 6265bis, enforced by Chrome and
 * Firefox), so the hint cookie — like the session cookie itself — is bounded
 * there and refreshed by the middleware's daily renewal. A user only loses it
 * by not visiting for roughly 400 days.
 */
export const COOKIE_MAX_AGE_SECONDS = Math.min(SESSION_TTL_SECONDS, 60 * 60 * 24 * 400);

/**
 * (Re)issues the `signed_in` hint cookie. Its only job is letting the header
 * skip the user island pre-paint, so its lifetime must track the real
 * session — a longer-lived hint made a forced logout look like a UI glitch
 * for weeks, because the header kept rendering the signed-in island that then
 * found nobody.
 */
export function setSignedInHint(ctx: APIContext): void {
  ctx.cookies.set('signed_in', '1', {
    path: '/',
    httpOnly: false,
    secure: ctx.url.protocol === 'https:',
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
}

/**
 * How stale a session may get before a request re-stamps it. The KV ttl is a
 * year and the cookie is capped at 400 days, so renewing weekly keeps an active
 * user signed in indefinitely while costing 1/7th of the KV puts a daily
 * renewal did (every renewal is a Workers KV put; the free tier is 1,000/day
 * for the whole account).
 */
const RENEW_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Users renewed recently by *this* isolate. A signed-in page load fires several
 * requests at once (page, chat polling, presence, islands), and every one of
 * them runs the middleware. Without this, all of them see a stale marker at the
 * same moment and each writes its own put.
 */
const recentlyRenewed = new Map<string, number>();

/** Only real page navigations renew: not polling, islands, assets or the API. */
function isPageNavigation(ctx: APIContext): boolean {
  if (ctx.request.method !== 'GET') return false;
  const path = ctx.url.pathname;
  if (path.startsWith('/api/') || path.startsWith('/_') || path.startsWith('/uploads/')) {
    return false;
  }
  return (ctx.request.headers.get('accept') ?? '').includes('text/html');
}

/**
 * Sliding session renewal.
 *
 * Astro stamps the server-side KV expiry and the browser cookie's maxAge
 * when the session is *written*, which otherwise happens only at sign-in —
 * making the TTL a hard cap from sign-in day, so every active user got
 * force-logged-out a week later no matter how much they used the site.
 *
 * Calling this from middleware: on a page navigation, once a week per user,
 * re-writes a marker into the session. That write re-stamps the KV TTL and
 * re-issues the session cookie with a fresh maxAge, so sessions effectively
 * never expire — Discord-style, only an explicit logout (or roughly a year
 * away) ends one. Anonymous visitors cost nothing: no user, no write.
 */
export async function touchSession(ctx: APIContext): Promise<void> {
  try {
    if (!isPageNavigation(ctx)) return;
    const session = ctx.session;
    const user = await session?.get('user');
    if (!user) return;

    const now = Date.now();
    const userId = String((user as { id?: unknown }).id ?? '');
    const seen = userId ? recentlyRenewed.get(userId) : undefined;
    if (seen && now - seen < RENEW_INTERVAL_MS) return;

    const last = Number((await session?.get('last_renewed_at')) ?? 0);
    if (last && now - last < RENEW_INTERVAL_MS) {
      if (userId) recentlyRenewed.set(userId, last);
      return;
    }

    // Claim the slot before the awaited write so concurrent requests skip it.
    if (userId) recentlyRenewed.set(userId, now);
    await session?.set('last_renewed_at', now);
    setSignedInHint(ctx);
  } catch {
    // Renewal is best-effort; never break a page over it.
  }
}
