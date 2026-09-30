import type { APIRoute } from 'astro';
import { db } from '../../../lib/db/client';
import { chatMessageReactions, chatMessages } from '../../../lib/db/schema';
import { currentUser } from '../../../lib/auth';
import { and, eq } from 'drizzle-orm';

export const prerender = false;

const ALLOWED_EMOJI = ['👍', '❤️', '🔥', '😂', '🎉', '👀', '🚀', '💯'];

export const POST: APIRoute = async (ctx) => {
  const user = await currentUser(ctx);
  if (!user) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const { messageId, emoji } = await ctx.request.json();
    if (!messageId || !emoji || !ALLOWED_EMOJI.includes(emoji)) {
      return new Response(JSON.stringify({ ok: false, error: 'Invalid message ID or emoji' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const mId = Number(messageId);

    // Check if user already reacted with this emoji
    const [existing] = await db()
      .select()
      .from(chatMessageReactions)
      .where(
        and(
          eq(chatMessageReactions.messageId, mId),
          eq(chatMessageReactions.userId, user.id),
          eq(chatMessageReactions.emoji, emoji),
        ),
      )
      .limit(1);

    if (existing) {
      // Toggle off
      await db()
        .delete(chatMessageReactions)
        .where(
          and(
            eq(chatMessageReactions.messageId, mId),
            eq(chatMessageReactions.userId, user.id),
            eq(chatMessageReactions.emoji, emoji),
          ),
        );

      return new Response(JSON.stringify({ ok: true, action: 'removed', emoji }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } else {
      // Toggle on
      await db()
        .insert(chatMessageReactions)
        .values({
          messageId: mId,
          userId: user.id,
          emoji,
        });

      return new Response(JSON.stringify({ ok: true, action: 'added', emoji }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  } catch (err: any) {
    console.error('[chat:react] Error toggling reaction:', err);
    return new Response(JSON.stringify({ ok: false, error: 'Failed to react' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
