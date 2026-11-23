import type { AstroCookies } from 'astro';

/**
 * Short-lived cookies for sign-in flow state (`oauth_state`, `oauth_next`,
 * `pending_vote`).
 *
 * These used to live in the Astro session, which is backed by Workers KV. Any
 * write to a session — even `session.delete()` of a key that was never set —
 * persists a brand-new KV entry, so every anonymous hit on /auth/*, and every
 * anonymous vote, cost one KV put. The free tier allows 1,000 puts per day for
 * the whole account, so scanners and crawlers probing those URLs were enough to
 * exhaust it and take the site down (Astro cannot persist the session once KV
 * starts returning 429).
 *
 * A cookie costs nothing. It is HttpOnly + SameSite=Lax (Lax still travels on
 * the top-level redirect back from Discord/Telegram), and on https it carries
 * the `__Host-` prefix so a sibling host cannot plant one.
 */

type Ctx = { cookies: AstroCookies; url: URL };

export type FlowKey = 'oauth_state' | 'oauth_next' | 'pending_vote';

const DEFAULT_MAX_AGE_SECONDS = 10 * 60;

function cookieName(ctx: Ctx, key: FlowKey): string {
  return ctx.url.protocol === 'https:' ? `__Host-${key}` : key;
}

export function setFlowCookie(
  ctx: Ctx,
  key: FlowKey,
  value: string,
  maxAge: number = DEFAULT_MAX_AGE_SECONDS,
): void {
  ctx.cookies.set(cookieName(ctx, key), value, {
    path: '/',
    httpOnly: true,
    secure: ctx.url.protocol === 'https:',
    sameSite: 'lax',
    maxAge,
  });
}

export function readFlowCookie(ctx: Ctx, key: FlowKey): string | undefined {
  const value = ctx.cookies.get(cookieName(ctx, key))?.value;
  return value ? value : undefined;
}

export function clearFlowCookie(ctx: Ctx, key: FlowKey): void {
  // Only emit a Set-Cookie when there is something to clear.
  if (!ctx.cookies.has(cookieName(ctx, key))) return;
  ctx.cookies.delete(cookieName(ctx, key), {
    path: '/',
    secure: ctx.url.protocol === 'https:',
  });
}
