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

  const d = db();
  const [dbUser] = await d
    .select({
      telegramId: users.telegramId,
    })
    .from(users)
    .where(eq(users.discordId, user.id));

  // A user must have at least ONE active authentication method to prevent account lockout.
  if (!dbUser?.telegramId) {
    return ctx.redirect('/me?discord=cannot_unlink_primary', 302);
  }

  await d
    .update(users)
    .set({
      discordLinked: false,
      discordUserId: null,
    })
    .where(eq(users.discordId, user.id));

  // Update in-memory session user
  user.discordLinked = false;
  await ctx.session?.set('user', user);

  return ctx.redirect('/me?discord=unlinked', 302);
};
