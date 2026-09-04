import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { db } from '../../../lib/db/client';
import { users } from '../../../lib/db/schema';
import { currentUser } from '../../../lib/auth';

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const user = await currentUser(ctx);
  if (!user) {
    return ctx.redirect('/?auth=sign_in_required', 302);
  }

  // Prevent account lockout: if this user only has Telegram (no Discord account, ID starts with tg:),
  // they cannot unlink Telegram or they will lose access permanently.
  if (user.id.startsWith('tg:')) {
    return ctx.redirect('/me?telegram=cannot_unlink_primary', 302);
  }

  const d = db();
  await d
    .update(users)
    .set({
      telegramId: null,
      telegramUsername: null,
      telegramPhotoUrl: null,
    })
    .where(eq(users.discordId, user.id));

  // Update session
  user.telegramId = null;
  user.telegramUsername = null;
  await ctx.session?.set('user', user);

  return ctx.redirect('/me?telegram=unlinked', 302);
};
