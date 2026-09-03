import type { APIRoute } from 'astro';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../../lib/db/client';
import { comments, reports, users, notifications, type Status } from '../../../lib/db/schema';
import { readConfig } from '../../../lib/settings';
import { notifyWatchers } from '../../../lib/notify';
import { logAction } from '../../../lib/staff';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Inbound sync endpoint for Discord Contributor Server events
 *
 * Authenticated via Authorization: Bearer <discord_sync_secret> header
 * or ?secret=<discord_sync_secret> query param.
 */
export const POST: APIRoute = async (ctx) => {
  const cfg = await readConfig();

  // Validate sync secret if configured
  if (cfg.discord_sync_secret) {
    const authHeader = ctx.request.headers.get('authorization');
    const token = authHeader?.replace(/^Bearer\s+/i, '') || ctx.url.searchParams.get('secret');
    if (token !== cfg.discord_sync_secret) {
      return json({ error: 'unauthorized' }, 401);
    }
  }

  let body: Record<string, any>;
  try {
    body = await ctx.request.json();
  } catch {
    return json({ error: 'invalid json payload' }, 400);
  }

  const { event, threadId, messageId, content, author, tagNames } = body;
  if (!threadId) {
    return json({ error: 'missing threadId' }, 400);
  }

  // Find the matching report
  const [report] = await db()
    .select()
    .from(reports)
    .where(eq(reports.discordThreadId, threadId));

  if (!report) {
    return json({ error: 'no report found for thread' }, 404);
  }

  const d = db();
  const cf = ctx.locals.cfContext;

  // 1. MESSAGE CREATE (New comment from Discord)
  if (event === 'MESSAGE_CREATE' || event === 'comment_create') {
    if (!messageId || !author?.id) {
      return json({ error: 'missing messageId or author' }, 400);
    }

    // Loop prevention: check if comment already exists with this discordMessageId
    const [existing] = await d
      .select({ id: comments.id })
      .from(comments)
      .where(eq(comments.discordMessageId, messageId));

    if (existing) {
      return json({ ok: true, status: 'already_synced', commentId: existing.id });
    }

    // Ensure author exists in users table
    const [existingUser] = await d
      .select()
      .from(users)
      .where(eq(users.discordId, author.id));

    if (!existingUser) {
      await d.insert(users).values({
        discordId: author.id,
        username: author.username || 'Discord User',
        avatarHash: author.avatar || null,
        accountCreatedAt: Math.floor(Date.now() / 1000),
      }).onConflictDoUpdate({
        target: users.discordId,
        set: {
          username: author.username || 'Discord User',
          avatarHash: author.avatar || null,
          lastLogin: sql`(unixepoch())`,
        },
      });
    }

    // Insert comment
    const [inserted] = await d.batch([
      d.insert(comments).values({
        reportId: report.id,
        userId: author.id,
        body: content || '',
        discordMessageId: messageId,
        source: 'discord',
      }).returning(),
      d.update(reports)
        .set({ commentCount: sql`${reports.commentCount} + 1`, updatedAt: sql`(unixepoch())` })
        .where(eq(reports.id, report.id)),
    ]);

    const newComment = inserted[0][0];

    // Notify report watchers
    const notifTask = notifyWatchers(report.id, 'comment', `Discord reply by ${author.username}`, author.id);
    if (cf) cf.waitUntil(notifTask);
    else await notifTask;

    return json({ ok: true, commentId: newComment?.id });
  }

  // 2. MESSAGE UPDATE (Comment edit from Discord)
  if (event === 'MESSAGE_UPDATE' || event === 'comment_edit') {
    if (!messageId) return json({ error: 'missing messageId' }, 400);

    await d.update(comments)
      .set({ body: content || '', updatedAt: sql`(unixepoch())` })
      .where(eq(comments.discordMessageId, messageId));

    return json({ ok: true, status: 'updated' });
  }

  // 3. MESSAGE DELETE (Comment delete from Discord)
  if (event === 'MESSAGE_DELETE' || event === 'comment_delete') {
    if (!messageId) return json({ error: 'missing messageId' }, 400);

    const [comment] = await d
      .select({ id: comments.id })
      .from(comments)
      .where(eq(comments.discordMessageId, messageId));

    if (comment) {
      await d.batch([
        d.delete(comments).where(eq(comments.id, comment.id)),
        d.update(reports)
          .set({ commentCount: sql`max(0, ${reports.commentCount} - 1)` })
          .where(eq(reports.id, report.id)),
      ]);
    }

    return json({ ok: true, status: 'deleted' });
  }

  // 4. THREAD STATUS / TAG UPDATE (Status change from Discord)
  if (event === 'THREAD_UPDATE' || event === 'status_update') {
    if (Array.isArray(tagNames)) {
      let targetStatus: Status | null = null;
      const lowerTags = tagNames.map((t: string) => t.toLowerCase());

      if (lowerTags.includes('fixed')) targetStatus = 'fixed';
      else if (lowerTags.includes("won't fix") || lowerTags.includes('wont fix')) targetStatus = 'wont_fix';
      else if (lowerTags.includes('duplicate')) targetStatus = 'duplicate';
      else if (lowerTags.includes('in progress')) targetStatus = 'in_progress';
      else if (lowerTags.includes('open')) targetStatus = 'open';

      if (targetStatus && targetStatus !== report.status) {
        await d.update(reports)
          .set({
            status: targetStatus,
            statusChangedAt: sql`(unixepoch())`,
            updatedAt: sql`(unixepoch())`,
          })
          .where(eq(reports.id, report.id));

        const notifTask = notifyWatchers(
          report.id,
          'status_changed',
          `Status changed to ${targetStatus} via Discord`,
          null,
        );
        if (cf) cf.waitUntil(notifTask);
        else await notifTask;

        return json({ ok: true, newStatus: targetStatus });
      }
    }
  }

  return json({ ok: true, status: 'no_action' });
};
