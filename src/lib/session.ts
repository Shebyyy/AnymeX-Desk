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

/** How stale a session may get before a request re-stamps it. */
const RENEW_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Sliding session renewal.
 *
 * Astro stamps the server-side KV expiry and the browser cookie's maxAge
 * when the session is *written*, which otherwise happens only at sign-in —
 * making the TTL a hard cap from sign-in day, so every active user got
 * force-logged-out a week later no matter how much they used the site.
 *
 * Calling this from middleware on every request: once a day, re-writes a
 * marker into the session. That write re-stamps the KV TTL and re-issues the
 * session cookie with a fresh maxAge, so sessions effectively never expire —
 * Discord-style, only an explicit logout (or roughly a year away) ends one.
 * Reads stay cheap: the session is loaded once per request anyway (the header
 * island and every gated page read it), so this adds no extra round-trip for
 * signed-in visitors and nothing at all for anonymous ones.
 */
export async function touchSession(ctx: APIContext): Promise<void> {
  try {
    const session = ctx.session;
    const user = await session?.get('user');
    if (!user) return;
    const last = Number((await session?.get('last_renewed_at')) ?? 0);
    if (last && Date.now() - last < RENEW_INTERVAL_MS) return;
    await session?.set('last_renewed_at', Date.now());
    setSignedInHint(ctx);
  } catch {
    // Renewal is best-effort; never break a page over it.
  }
}
