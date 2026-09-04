import type { APIRoute } from 'astro';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../../lib/db/client';
import { users } from '../../../lib/db/schema';
import { buildTelegramSessionUser, canWriteNow, currentUser, mergeUserAccounts } from '../../../lib/auth';
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

  const rawNext = rawParams.next || (await ctx.session?.get('oauth_next'));
  const next = safeReturnTo(rawNext, ctx.url.origin);
  ctx.session?.delete('oauth_next');

  const loggedInUser = await currentUser(ctx);
  const errorRedirect = (err: string) => {
    if (loggedInUser || next === '/me') {
      return ctx.redirect(`/me?telegram=${encodeURIComponent(err)}`, 302);
    }
    return ctx.redirect(`/auth/telegram?error=${encodeURIComponent(err)}`, 302);
  };

  const hash = rawParams.hash;
  const telegramId = rawParams.id;
  if (!hash || !telegramId) {
    return errorRedirect('missing_params');
  }

  const botToken =
    (await readSetting('telegram_bot_token')) ||
    (await readConfig()).telegram_bot_token;

  if (!botToken) {
    console.error('[auth:telegram] Bot token not configured');
    return errorRedirect('not_configured');
  }

  // 1. Cryptographic HMAC verification
  const verification = await verifyTelegramAuth(rawParams, botToken);
  if (!verification.valid) {
    console.warn('[auth:telegram] Verification failed:', verification.reason);
    return errorRedirect(`invalid_signature_${verification.reason || 'unknown'}`);
  }

  const d = db();

  try {
    // Case A: User is already logged in — they came from /me to LINK Telegram!
    if (loggedInUser) {
      // Check if this telegramId is already linked to ANOTHER account
      const [conflict] = await d
        .select({
          discordId: users.discordId,
          discordLinked: users.discordLinked,
        })
        .from(users)
        .where(eq(users.telegramId, telegramId));

      if (conflict && conflict.discordId !== loggedInUser.id) {
        // Can we merge?
        // If conflict is a temporary tg:... placeholder created by Telegram login:
        if (conflict.discordId.startsWith('tg:')) {
          await mergeUserAccounts(conflict.discordId, loggedInUser.id, {
            telegramId,
            telegramUsername: rawParams.username || null,
            telegramPhotoUrl: rawParams.photo_url || null,
          });

          loggedInUser.telegramId = telegramId;
          loggedInUser.telegramUsername = rawParams.username || null;
          await ctx.session?.set('user', loggedInUser);

          ctx.cookies.set('signed_in', '1', {
            path: '/',
            httpOnly: false,
            secure: ctx.url.protocol === 'https:',
            sameSite: 'lax',
            maxAge: 60 * 60 * 24 * 30,
          });

          return ctx.redirect('/me?telegram=linked', 302);
        }

        // If it was linked to an old account, the user just verified ownership of this Telegram account via HMAC.
        // Detach it from the old account so it can link to the active account.
        await d
          .update(users)
          .set({
            telegramId: null,
            telegramUsername: null,
            telegramPhotoUrl: null,
            notifyTelegram: false,
          })
          .where(eq(users.discordId, conflict.discordId));
      }

      await d
        .update(users)
        .set({
          telegramId,
          telegramUsername: rawParams.username || null,
          telegramPhotoUrl: rawParams.photo_url || null,
          notifyTelegram: true,
          lastLogin: sql`(unixepoch())`,
          lastSeen: sql`(unixepoch())`,
        })
        .where(eq(users.discordId, loggedInUser.id));

      // Refresh session user
      loggedInUser.telegramId = telegramId;
      loggedInUser.telegramUsername = rawParams.username || null;
      await ctx.session?.set('user', loggedInUser);

      ctx.cookies.set('signed_in', '1', {
        path: '/',
        httpOnly: false,
        secure: ctx.url.protocol === 'https:',
        sameSite: 'lax',
        maxAge: 60 * 60 * 24 * 30,
      });

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
    return errorRedirect('failed');
  } finally {
    ctx.session?.delete('pending_vote');
  }

  return ctx.redirect(next || '/', 302);
};
