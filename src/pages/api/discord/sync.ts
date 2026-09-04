import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../../lib/db/client';
import { comments, reports, users, notifications, attachments, type Status } from '../../../lib/db/schema';
import { readConfig } from '../../../lib/settings';
import { notifyWatchers, sendDiscordDm, truncateQuote } from '../../../lib/notify';
import { BLURPLE } from '../../../lib/webhook';
import { logAction } from '../../../lib/staff';
import { syncReportStatusFromDiscord } from '../../../lib/discord-forums';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function validateSecret(req: Request, url: URL, secret: string): boolean {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.replace(/^Bearer\s+/i, '') || url.searchParams.get('secret');
  return token === secret;
}

/**
 * GET — health check for bot connectivity testing.
 * Returns { ok, threadCount } so the bot can verify the endpoint is reachable.
 */
export const GET: APIRoute = async (ctx) => {
  const cfg = await readConfig();
  if (cfg.discord_sync_secret) {
    if (!validateSecret(ctx.request, ctx.url, cfg.discord_sync_secret)) {
      return json({ error: 'unauthorized' }, 401);
    }
  }

  const [row] = await db()
    .select({ n: sql<number>`count(*)` })
    .from(reports)
    .where(sql`discord_thread_id IS NOT NULL`);

  return json({ ok: true, syncedThreads: row?.n ?? 0, ts: Math.floor(Date.now() / 1000) });
};

/**
 * POST — Inbound sync endpoint for Discord Contributor Server events.
 *
 * Authenticated via Authorization: Bearer <discord_sync_secret> header
 * or ?secret=<discord_sync_secret> query param.
 *
 * Payload fields:
 *   event          — MESSAGE_CREATE | MESSAGE_UPDATE | MESSAGE_DELETE | THREAD_UPDATE
 *   threadId       — Discord forum thread snowflake
 *   messageId      — Discord message snowflake
 *   content        — plain text body
 *   author         — { id, username, avatar }
 *   replyToMessageId — optional: message_id of the message being replied to
 *   attachments    — optional: [{ url, filename, content_type }]
 *   tagNames       — optional: for THREAD_UPDATE, the new applied tag names
 */
export const POST: APIRoute = async (ctx) => {
  const cfg = await readConfig();

  // Validate sync secret if configured
  if (cfg.discord_sync_secret) {
    if (!validateSecret(ctx.request, ctx.url, cfg.discord_sync_secret)) {
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

  // ── 1. MESSAGE CREATE (New comment from Discord) ──────────────────────────
  if (event === 'MESSAGE_CREATE' || event === 'comment_create') {
    if (!messageId || !author?.id) {
      return json({ error: 'missing messageId or author' }, 400);
    }

    // Loop prevention: skip messages sent by the site's own bot
    if (author.bot === true && author.id === cfg.discord_bot_token?.split('.')[0]) {
      return json({ ok: true, status: 'skipped_own_bot' });
    }

    // Loop prevention: skip if comment already exists with this discordMessageId
    const [existing] = await d
      .select({ id: comments.id })
      .from(comments)
      .where(eq(comments.discordMessageId, messageId));

    if (existing) {
      return json({ ok: true, status: 'already_synced', commentId: existing.id });
    }

    // Upsert author into users table
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

    // Resolve replyToId if replying to a known site comment
    const replyDiscordMsgId = body.replyToMessageId || body.message_reference?.message_id;
    let replyToId: number | null = null;
    let parentCommentAuthorId: string | null = null;

    if (replyDiscordMsgId) {
      const [parent] = await d
        .select({ id: comments.id, userId: comments.userId })
        .from(comments)
        .where(eq(comments.discordMessageId, replyDiscordMsgId));
      if (parent) {
        replyToId = parent.id;
        parentCommentAuthorId = parent.userId;
      }
    }

    // Insert comment
    const [[insertedRows]] = await d.batch([
      d.insert(comments).values({
        reportId: report.id,
        userId: author.id,
        body: content || '',
        discordMessageId: messageId,
        source: 'discord',
        replyToId,
      }).returning(),
      d.update(reports)
        .set({ commentCount: sql`${reports.commentCount} + 1`, updatedAt: sql`(unixepoch())` })
        .where(eq(reports.id, report.id)),
    ]);

    const newComment = insertedRows[0];

    // Store Discord attachments — save CDN URL in KV for the proxy route
    const incomingAttachments: Array<{ url: string; filename: string; content_type?: string }> =
      body.attachments || [];
    const kv = env.SESSION as KVNamespace | undefined;

    for (const att of incomingAttachments) {
      if (!att.url) continue;
      const mime = att.content_type || 'application/octet-stream';
      let fileType = 'file';
      if (mime.startsWith('image/')) fileType = 'image';
      else if (mime.startsWith('video/')) fileType = 'video';

      // Generate a stable path for this attachment
      const uuid = crypto.randomUUID();
      const filePath = `uploads/${uuid}/${att.filename}`;

      // Store the CDN URL in KV so the proxy route can redirect to it
      if (kv) {
        await kv.put(`discord_cdn:${filePath}`, att.url, {
          expirationTtl: 60 * 60 * 24 * 365, // 1 year
        });
      }

      await d.insert(attachments).values({
        reportId: report.id,
        commentId: newComment?.id ?? null,
        fileName: att.filename,
        filePath,
        fileType,
        mimeType: mime,
        fileSize: 0, // Unknown from Discord payload
        discordCdnUrl: att.url,
      });
    }

    // Notify parent comment author if this was a reply
    if (parentCommentAuthorId && parentCommentAuthorId !== author.id) {
      await d.insert(notifications).values({
        userId: parentCommentAuthorId,
        reportId: report.id,
        kind: 'mentioned',
        detail: `${author.username} replied to your comment from Discord`,
      });
      sendDiscordDm(parentCommentAuthorId, {
        author: author.username,
        title: 'New reply to your comment',
        description: truncateQuote(content || ''),
        url: `${ctx.url.origin}/report/${report.id}#comment-${newComment?.id}`,
        color: BLURPLE,
        footer: report.title,
      }).catch(() => {});
    }

    // Notify report watchers
    const notifTask = notifyWatchers(
      report.id,
      'comment',
      `Discord message by ${author.username}`,
      author.id,
    );
    if (cf) cf.waitUntil(notifTask);
    else await notifTask;

    return json({ ok: true, commentId: newComment?.id });
  }

  // ── 2. MESSAGE UPDATE (Comment edit from Discord) ─────────────────────────
  if (event === 'MESSAGE_UPDATE' || event === 'comment_edit') {
    if (!messageId) return json({ error: 'missing messageId' }, 400);

    await d.update(comments)
      .set({ body: content || '', updatedAt: sql`(unixepoch())` })
      .where(eq(comments.discordMessageId, messageId));

    return json({ ok: true, status: 'updated' });
  }

  // ── 3. MESSAGE DELETE (Comment delete from Discord) ───────────────────────
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

  // ── 4. THREAD STATUS / TAG UPDATE (Status change from Discord) ────────────
  if (event === 'THREAD_UPDATE' || event === 'status_update') {
    let newStatus: Status | null = null;

    // Fast-path: map tagNames sent directly by the bot
    if (Array.isArray(tagNames) && tagNames.length > 0) {
      for (const rawName of tagNames) {
        const name = String(rawName).toLowerCase().trim();
        if (name === 'fixed' || name === 'completed' || name === 'resolved') newStatus = 'fixed';
        else if (name === 'in progress' || name === 'in-progress') newStatus = 'in_progress';
        else if (name === 'planned') newStatus = 'confirmed';
        else if (name === 'under review' || name === 'under-review') newStatus = 'under_review';
        else if (name === 'open') newStatus = 'open';
        else if (name === 'confirmed') newStatus = 'confirmed';
        else if (name === "won't fix" || name === 'wont fix' || name === 'declined') newStatus = 'wont_fix';
        else if (name === 'duplicate') newStatus = 'duplicate';
      }

      if (newStatus && newStatus !== report.status) {
        await d
          .update(reports)
          .set({
            status: newStatus,
            statusChangedAt: sql`(unixepoch())`,
            updatedAt: sql`(unixepoch())`,
          })
          .where(eq(reports.id, report.id));
      }
    }

    // Fallback: query Discord API for tags if tagNames wasn't provided or didn't change
    if (!newStatus || newStatus === report.status) {
      newStatus = await syncReportStatusFromDiscord(report);
    }

    if (newStatus && newStatus !== report.status) {
      const notifTask = notifyWatchers(
        report.id,
        'status_changed',
        `Status changed to ${newStatus} via Discord`,
        null,
      );
      if (cf) cf.waitUntil(notifTask);
      else await notifTask;

      return json({ ok: true, newStatus });
    }
    return json({ ok: true, status: 'no_change' });
  }

  return json({ ok: true, status: 'no_action' });
};
