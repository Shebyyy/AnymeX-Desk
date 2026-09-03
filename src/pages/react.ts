import type { APIRoute } from 'astro';
import { and, eq, sql } from 'drizzle-orm';
import { canWriteNow, currentUser } from '../lib/auth';
import { db } from '../lib/db/client';
import { commentReactions, comments } from '../lib/db/schema';

export const prerender = false;

/** The five emoji users may pick. */
export const ALLOWED_EMOJI = ['👍', '✅', '🤔', '❌', '🎉'] as const;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * POST /react
 *
 * Body (JSON or form): { commentId: number, emoji: string }
 * Toggles the reaction: adds if not present, removes if it is.
 * Returns { action: 'added' | 'removed', emoji, counts: Record<emoji, number> }.
 */
export const POST: APIRoute = async (ctx) => {
  const user = await currentUser(ctx);
  if (!user) return json({ error: 'sign-in' }, 401);
  if (!(await canWriteNow(user))) return json({ error: 'banned' }, 403);

  let commentId: number;
  let emoji: string;

  const ct = ctx.request.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const body = (await ctx.request.json()) as { commentId?: unknown; emoji?: unknown };
    commentId = Number(body.commentId);
    emoji = String(body.emoji ?? '');
  } else {
    const form = await ctx.request.formData();
    commentId = Number(form.get('commentId'));
    emoji = String(form.get('emoji') ?? '');
  }

  if (!Number.isSafeInteger(commentId) || commentId <= 0)
    return json({ error: 'invalid commentId' }, 400);
  if (!(ALLOWED_EMOJI as readonly string[]).includes(emoji))
    return json({ error: 'unsupported emoji' }, 400);

  // Verify the comment exists.
  const [comment] = await db()
    .select({ id: comments.id })
    .from(comments)
    .where(eq(comments.id, commentId));
  if (!comment) return json({ error: 'comment not found' }, 404);

  // Toggle: try DELETE first; if nothing removed, INSERT.
  const deleted = await db()
    .delete(commentReactions)
    .where(
      and(
        eq(commentReactions.commentId, commentId),
        eq(commentReactions.discordId, user.id),
        eq(commentReactions.emoji, emoji),
      ),
    )
    .returning({ commentId: commentReactions.commentId });

  let action: 'added' | 'removed';
  if (deleted.length > 0) {
    action = 'removed';
  } else {
    await db()
      .insert(commentReactions)
      .values({ commentId, discordId: user.id, emoji })
      .onConflictDoNothing();
    action = 'added';
  }

  // Return fresh counts for all emoji on this comment.
  const countRows = await db().all(sql`
    SELECT emoji, count(*) AS n
    FROM comment_reactions
    WHERE comment_id = ${commentId}
    GROUP BY emoji
  `) as { emoji: string; n: number }[];

  const counts: Record<string, number> = {};
  for (const { emoji: e, n } of countRows) counts[e] = n;

  return json({ action, emoji, counts });
};
