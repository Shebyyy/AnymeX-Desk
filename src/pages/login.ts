import type { APIRoute } from 'astro';
import { safeReturnTo } from '../lib/redirect';

export const prerender = false;

export const GET: APIRoute = async (ctx) => {
  const next = safeReturnTo(ctx.url.searchParams.get('next'), ctx.url.origin, '/');
  return ctx.redirect(`/auth/login?next=${encodeURIComponent(next)}`, 302);
};
