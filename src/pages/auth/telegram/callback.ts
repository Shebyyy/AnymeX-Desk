import type { APIRoute } from 'astro';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../../lib/db/client';
import { users } from '../../../lib/db/schema';
import { buildTelegramSessionUser, canWriteNow, currentUser } from '../../../lib/auth';
import { readConfig, readSetting } from '../../../lib/settings';
import { verifyTelegramAuth } from '../../../lib/telegram-auth';
import { safeReturnTo } from '../../../lib/redirect';
import { ensureVote } from '../../../lib/vote';

export const prerender = false;

export const GET: APIRoute = async (ctx) => {
  const url = ctx.url;
  const rawParams: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) {
    rawParams[k] = v;
  }

  const hash = rawParams.hash;
  const telegramId = rawParams.id;
  if (!hash || !telegramId) {
    return ctx.redirect('/?auth=telegram_missing_params', 302);
  }

  const botToken =
    (await readSetting('telegram_bot_token')) ||
    (await readConfig()).telegram_bot_token;

  if (!botToken) {
    console.error('[auth:telegram] Bot token not configured');
    return ctx.redirect('/?auth=telegram_not_configured', 302);
  }

  // 1. Cryptographic HMAC verification
  const verification = await verifyTelegramAuth(rawParams, botToken);
  if (!verification.valid) {
    console.warn('[auth:telegram] Verification failed:', verification.reason);
    return ctx.redirect('/?auth=telegram_invalid_signature', 302);
  }

  const next = safeReturnTo(await ctx.session?.get('oauth_next'), ctx.url.origin);
  ctx.session?.delete('oauth_next');

  const loggedInUser = await currentUser(ctx);
  const d = db();

  try {
    // Case A: User is already logged in — they came from /me to LINK Telegram!
    if (loggedInUser) {
      // Check if this telegramId is already linked to ANOTHER account
      const [conflict] = await d
        .select({ discordId: users.discordId })
        .from(users)
        .where(eq(users.telegramId, telegramId));

      if (conflict && conflict.discordId !== loggedInUser.id) {
        return ctx.redirect('/me?telegram=already_linked_to_other_account', 302);
      }

      await d
        .update(users)
        .set({
          telegramId,
          telegramUsername: rawParams.username || null,
          telegramPhotoUrl: rawParams.photo_url || null,
          notifyTelegram: true,
          lastLogin: sql`(unixepoch())`,
        })
        .where(eq(users.discordId, loggedInUser.id));

      // Refresh session user
      loggedInUser.telegramId = telegramId;
      loggedInUser.telegramUsername = rawParams.username || null;
      await ctx.session?.set('user', loggedInUser);

      return ctx.redirect('/me?telegram=linked', 302);
    }

    // Case B: Sign-in / Register via Telegram
    const sessionUser = await buildTelegramSessionUser({
      id: telegramId,
      first_name: rawParams.first_name,
      last_name: rawParams.last_name,
      username: rawParams.username,
      photo_url: rawParams.photo_url,
      auth_date: rawParams.auth_date,
    });

    // Prevent session fixation
    await ctx.session?.regenerate();
    await ctx.session?.set('user', sessionUser);

    ctx.cookies.set('signed_in', '1', {
      path: '/',
      httpOnly: false,
      secure: ctx.url.protocol === 'https:',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30,
    });

    // Resolve any pending vote
    const pendingVote = await ctx.session?.get('pending_vote');
    if (pendingVote && (await canWriteNow(sessionUser))) {
      await ensureVote(Number(pendingVote), sessionUser.id);
    }
  } catch (err) {
    console.error('[auth:telegram] Login callback error:', err);
    return ctx.redirect('/?auth=failed', 302);
  } finally {
    ctx.session?.delete('pending_vote');
  }

  return ctx.redirect(next || '/', 302);
};
