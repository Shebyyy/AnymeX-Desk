import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../../lib/db/client';
import { comments, reports, users, notifications, attachments, type Status } from '../../../lib/db/schema';
import { readConfig } from '../../../lib/settings';
import { notifyWatchers, sendDiscordDm, truncateQuote } from '../../../lib/notify';
import { BLURPLE } from '../../../lib/webhook';
import { logAction } from '../../../lib/staff';
import {
  syncReportStatusFromDiscord,
  ensureForumTags,
  getForumChannelId,
  mapTagNameToStatus,
} from '../../../lib/discord-forums';

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
    const [insertedRows] = await d.batch([
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

    // Store Discord attachments — cache to KV so links do not break after CDN URL expiry
    const incomingAttachments: Array<{ url: string; filename: string; content_type?: string; size?: number }> =
      body.attachments || [];
    for (const att of incomingAttachments) {
      if (!att.url) continue;
      const mime = att.content_type || 'application/octet-stream';
      let fileType = 'file';
      if (mime.startsWith('image/')) fileType = 'image';
      else if (mime.startsWith('video/')) fileType = 'video';

      const filePath = att.url;
      const fileSize = Number(att.size) || 0;

      try {
        await d.insert(attachments).values({
          reportId: report.id,
          commentId: newComment?.id ?? null,
          fileName: att.filename || 'attachment',
          filePath,
          fileType,
          mimeType: mime,
          fileSize,
          discordCdnUrl: att.url,
        });
      } catch {
        await d.insert(attachments).values({
          reportId: report.id,
          commentId: newComment?.id ?? null,
          fileName: att.filename || 'attachment',
          filePath,
          fileType,
          mimeType: mime,
          fileSize,
        });
      }
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
        d.delete(attachments).where(eq(attachments.commentId, comment.id)),
        d.update(reports)
          .set({ commentCount: sql`max(0, ${reports.commentCount} - 1)` })
          .where(eq(reports.id, report.id)),
      ]);
    }

    return json({ ok: true, status: 'deleted' });
  }

  // ── 3b. THREAD DELETE (Thread / Report deleted from Discord) ──────────────
  if (event === 'THREAD_DELETE' || event === 'thread_delete') {
    if (report) {
      await d.batch([
        d.delete(reports).where(eq(reports.id, report.id)),
        d.delete(comments).where(eq(comments.reportId, report.id)),
        d.delete(attachments).where(eq(attachments.reportId, report.id)),
      ]);
    }
    return json({ ok: true, status: 'thread_deleted' });
  }

  // ── 4. THREAD STATUS / TAG UPDATE (Status change from Discord) ────────────
  if (event === 'THREAD_UPDATE' || event === 'status_update') {
    const now = Math.floor(Date.now() / 1000);
    const isRecentSiteUpdate = report.updatedAt ? (now - Number(report.updatedAt) < 15) : false;
    let newStatus: Status | null = null;

    // Resolve tags (handles both tag names and Discord snowflake IDs)
    const rawTags = body.appliedTags || tagNames;
    const tagsChanged = (body as any).tagsChanged !== false;
    if (tagsChanged && !isRecentSiteUpdate && Array.isArray(rawTags) && rawTags.length > 0) {
      let resolvedNames: string[] = [];
      const firstTag = String(rawTags[0]).trim();
      const isSnowflake = /^\d{15,22}$/.test(firstTag);

      if (isSnowflake && cfg.discord_bot_token) {
        const channelId = getForumChannelId(report.kind, cfg);
        if (channelId) {
          try {
            const tagsMap = await ensureForumTags(channelId, cfg.discord_bot_token, report.kind);
            const idToName = new Map<string, string>();
            for (const [name, id] of tagsMap.entries()) {
              idToName.set(id, name);
            }
            for (const tagId of rawTags) {
              const name = idToName.get(String(tagId));
              if (name) resolvedNames.push(name);
            }
          } catch (err) {
            console.warn('[Sync] Failed to resolve tag IDs:', err);
          }
        }
      } else {
        resolvedNames = rawTags.map((t) => String(t));
      }

      for (const rawName of resolvedNames) {
        const st = mapTagNameToStatus(rawName);
        if (st) newStatus = st;
      }

      if (newStatus && newStatus !== report.status) {
        const isClosing = newStatus === 'fixed' || newStatus === 'already_available' || newStatus === 'wont_fix' || newStatus === 'duplicate';
        await d
          .update(reports)
          .set({
            status: newStatus,
            locked: isClosing ? true : report.locked,
            statusChangedAt: sql`(unixepoch())`,
            updatedAt: sql`(unixepoch())`,
          })
          .where(eq(reports.id, report.id));
      }
    }

    // Handle thread locked state changes from Discord.
    // Use Boolean(...) normalization so SQLite integer 1/0 equals JS true/false.
    // Also ignore if the report was just updated on the site within the last 15s.
    let lockChanged = false;
    const isNowLocked = typeof body.locked === 'boolean' ? body.locked : (body.archived === true ? true : undefined);
    if (
      typeof isNowLocked === 'boolean' &&
      Boolean(isNowLocked) !== Boolean(report.locked) &&
      !isRecentSiteUpdate
    ) {
      lockChanged = true;
      await d
        .update(reports)
        .set({
          locked: isNowLocked,
          updatedAt: sql`(unixepoch())`,
        })
        .where(eq(reports.id, report.id));

      const log = logAction(
        { id: author?.id || 'discord', username: author?.username || 'Discord Mod' } as any,
        isNowLocked ? 'report.lock' : 'report.unlock',
        `report #${report.id}`,
        isNowLocked ? 'locked (via Discord)' : 'unlocked (via Discord)',
        `${ctx.url.origin}/report/${report.id}`,
      );
      if (cf) cf.waitUntil(log);
      else await log;
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

      return json({ ok: true, newStatus, locked: lockChanged ? isNowLocked : report.locked });
    }
    if (lockChanged) {
      return json({ ok: true, locked: isNowLocked });
    }
    return json({ ok: true, status: 'no_change' });
  }

  return json({ ok: true, status: 'no_action' });
};
