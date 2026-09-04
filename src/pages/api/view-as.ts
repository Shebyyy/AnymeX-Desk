import type { APIRoute } from 'astro';
import { currentUser } from '../../lib/auth';
import { levelOf } from '../../lib/staff';
import { RANK, type Level } from '../../lib/levels';
import { safeReturnTo } from '../../lib/redirect';

export const prerender = false;

/**
 * API route to switch or exit "View as Role" preview mode.
 * Enforces strict tiered permissions:
 * - Owner can preview: Owner, Admin, Mod, User.
 * - Admin can preview: Admin, Mod, User (cannot preview Owner).
 * - Mod can preview: Mod, User (cannot preview Admin or Owner).
 * - Member cannot preview any staff role.
 */
export const POST: APIRoute = async (ctx) => {
  const user = await currentUser(ctx);
  if (!user) {
    return new Response('Unauthorized', { status: 401 });
  }

  const realLevel = await levelOf(user.id);
  if (realLevel === 'user') {
    return new Response('Forbidden: Only staff members may use role preview', { status: 403 });
  }

  let role = '';
  const contentType = ctx.request.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const body = await ctx.request.json().catch(() => ({}));
    role = String(body.role ?? '');
  } else {
    const form = await ctx.request.formData().catch(() => new FormData());
    role = String(form.get('role') ?? '');
  }

  const referer = ctx.request.headers.get('referer');
  const returnTo = safeReturnTo(referer, ctx.url.origin, '/admin');

  // Clear or return to authentic real level
  if (!role || role === 'clear' || role === realLevel) {
    ctx.cookies.delete('anymex_view_as', { path: '/' });
    return ctx.redirect(returnTo, 303);
  }

  if (!(role in RANK)) {
    return new Response('Invalid role', { status: 400 });
  }

  const targetRole = role as Level;

  // STRICT TIERED PREVIEW GUARD: Cannot preview higher than authentic rank
  if (RANK[targetRole] > RANK[realLevel]) {
    return new Response('Forbidden: Cannot preview a role higher than your authentic level', { status: 403 });
  }

  ctx.cookies.set('anymex_view_as', targetRole, {
    path: '/',
    httpOnly: false,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24, // 24 hours
  });

  return ctx.redirect(returnTo, 303);
};

export const GET: APIRoute = async (ctx) => {
  const role = ctx.url.searchParams.get('role');
  const user = await currentUser(ctx);
  const referer = ctx.request.headers.get('referer');
  const returnTo = safeReturnTo(referer, ctx.url.origin, '/admin');

  if (!user) {
    return ctx.redirect('/auth/discord', 302);
  }

  const realLevel = await levelOf(user.id);
  if (realLevel === 'user') {
    return new Response('Forbidden: Only staff members may use role preview', { status: 403 });
  }

  if (!role || role === 'clear' || role === realLevel) {
    ctx.cookies.delete('anymex_view_as', { path: '/' });
    return ctx.redirect(returnTo, 303);
  }

  if (role in RANK && RANK[role as Level] <= RANK[realLevel]) {
    ctx.cookies.set('anymex_view_as', role, {
      path: '/',
      httpOnly: false,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24,
    });
  }

  return ctx.redirect(returnTo, 303);
};
