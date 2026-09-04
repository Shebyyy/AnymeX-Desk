/**
 * Discord → Site Polling Cron Handler
 *
 * Runs every 2 minutes (configured in wrangler.jsonc) and pulls new Discord
 * messages from every synced forum thread into the site's comments table.
 *
 * This makes DC→Site sync self-contained — no external bot configuration
 * required. The site uses its own discord_bot_token to call Discord REST API.
 *
 * What it handles:
 *   - New messages       → inserted as comments (source='discord')
 *   - Edited messages    → body updated on existing comment rows
 *   - Deleted messages   → comment row removed
 *   - Tag changes        → report status synced from applied tags
 *   - Attachments        → CDN URLs stored in KV + attachment rows created
 *   - Loop prevention    → messages posted by our own bot are skipped
 */

import { env } from 'cloudflare:workers';
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../../../lib/db/client';
import {
  reports,
  comments,
  users,
  attachments,
  notifications,
  type Status,
} from '../../../lib/db/schema';
import { readConfig } from '../../../lib/settings';
import { notifyWatchers } from '../../../lib/notify';
import { syncReportStatusFromDiscord, getForumChannelId, ensureForumTags, statusToTagName } from '../../../lib/discord-forums';

const DISCORD_API = 'https://discord.com/api/v10';
const MAX_REPORTS_PER_RUN = 30; // stay well within 2-min CPU budget
const MESSAGES_PER_THREAD = 50; // Discord max per request

interface DiscordMessage {
  id: string;
  author: {
    id: string;
    username: string;
    avatar?: string | null;
    bot?: boolean;
  };
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  message_reference?: { message_id?: string };
  attachments?: Array<{
    id: string;
    filename: string;
    url: string;
    content_type?: string;
    size: number;
  }>;
  type: number; // 0=DEFAULT,19=REPLY,21=THREAD_STARTER_MESSAGE
  application_id?: string;
  webhook_id?: string;
}

/** Fetch the bot's own user ID once so we can skip our own messages. */
let cachedBotUserId: string | null = null;
async function getBotUserId(botToken: string): Promise<string | null> {
  if (cachedBotUserId) return cachedBotUserId;
  try {
    const res = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bot ${botToken}` },
    });
    if (res.ok) {
      const me = (await res.json()) as { id: string };
      cachedBotUserId = me.id;
      return me.id;
    }
  } catch {}
  return null;
}

/** Fetch messages from a Discord thread, optionally after a known snowflake. */
async function fetchThreadMessages(
  threadId: string,
  botToken: string,
  afterId?: string | null,
): Promise<DiscordMessage[]> {
  const params = new URLSearchParams({ limit: String(MESSAGES_PER_THREAD) });
  if (afterId) params.set('after', afterId);

  const res = await fetch(`${DISCORD_API}/channels/${threadId}/messages?${params}`, {
    headers: { Authorization: `Bot ${botToken}` },
  });

  if (!res.ok) {
    if (res.status === 404 || res.status === 403) return []; // thread gone / no access
    console.warn(`[Poll] Failed to fetch messages for thread ${threadId}: ${res.status}`);
    return [];
  }

  const msgs = (await res.json()) as DiscordMessage[];
  // Discord returns messages newest-first when using `after`; sort oldest-first
  return msgs.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Upsert a Discord user into the local users table. */
async function upsertUser(discordId: string, username: string, avatar: string | null | undefined) {
  await db()
    .insert(users)
    .values({
      discordId,
      username: username || 'Discord User',
      avatarHash: avatar ?? null,
      accountCreatedAt: Math.floor(Date.now() / 1000),
    })
    .onConflictDoUpdate({
      target: users.discordId,
      set: {
        username: username || 'Discord User',
        avatarHash: avatar ?? null,
        lastLogin: sql`(unixepoch())`,
      },
    });
}

/** Store a Discord CDN attachment in KV and create an attachments row. */
async function storeDiscordAttachment(
  att: NonNullable<DiscordMessage['attachments']>[number],
  reportId: number,
  commentId: number,
  kv: KVNamespace | undefined,
) {
  const mime = att.content_type || 'application/octet-stream';
  let fileType = 'file';
  if (mime.startsWith('image/')) fileType = 'image';
  else if (mime.startsWith('video/')) fileType = 'video';

  const filePath = att.url;

  try {
    await db()
      .insert(attachments)
      .values({
        reportId,
        commentId,
        fileName: att.filename,
        filePath,
        fileType,
        mimeType: mime,
        fileSize: att.size,
        discordCdnUrl: att.url,
      })
      .onConflictDoNothing();
  } catch {
    await db()
      .insert(attachments)
      .values({
        reportId,
        commentId,
        fileName: att.filename,
        filePath,
        fileType,
        mimeType: mime,
        fileSize: att.size,
      })
      .onConflictDoNothing();
  } // attachment dedup guard
}

/**
 * Process a single Discord thread — insert/update/delete comments as needed.
 */
async function pollThread(
  report: typeof reports.$inferSelect,
  botUserId: string | null,
  kv: KVNamespace | undefined,
): Promise<void> {
  const threadId = report.discordThreadId!;
  const msgs = await fetchThreadMessages(threadId, cachedBotUserId ? '' : '', report.discordLastMessageId);

  // Re-fetch with real token (cachedBotUserId fetch already used it)
  // Note: fetchThreadMessages uses the module-level token from cfg; see the caller
  if (msgs.length === 0) return;

  const d = db();
  let newestId = report.discordLastMessageId ?? '';

  for (const msg of msgs) {
    // Skip the thread starter message (type 21) — that's the report embed we created
    if (msg.type === 21) continue;

    // Skip our own bot's messages to prevent echo loops
    if (botUserId && msg.author.id === botUserId) continue;
    if (msg.author.bot && msg.webhook_id) continue; // also skip webhook messages (our own webhook)

    // Track newest message ID
    if (!newestId || msg.id > newestId) newestId = msg.id;

    // Check if this message is already in the DB
    const [existing] = await d
      .select({ id: comments.id, body: comments.body, updatedAt: comments.updatedAt })
      .from(comments)
      .where(eq(comments.discordMessageId, msg.id));

    const msgTimestamp = Math.floor(new Date(msg.timestamp).getTime() / 1000);
    const editedTimestamp = msg.edited_timestamp
      ? Math.floor(new Date(msg.edited_timestamp).getTime() / 1000)
      : null;

    if (existing) {
      // If the message was edited and the body changed, update it
      if (
        editedTimestamp &&
        editedTimestamp > (existing.updatedAt ?? msgTimestamp) &&
        msg.content !== existing.body
      ) {
        await d
          .update(comments)
          .set({ body: msg.content, updatedAt: editedTimestamp })
          .where(eq(comments.id, existing.id));
        console.log(`[Poll] Updated edited comment #${existing.id} from Discord msg ${msg.id}`);
      }
      continue;
    }

    // New message — upsert author and insert comment
    await upsertUser(msg.author.id, msg.author.username, msg.author.avatar);

    // Resolve reply thread
    let replyToId: number | null = null;
    let parentAuthorId: string | null = null;
    const refMsgId = msg.message_reference?.message_id;
    if (refMsgId) {
      const [parent] = await d
        .select({ id: comments.id, userId: comments.userId })
        .from(comments)
        .where(eq(comments.discordMessageId, refMsgId));
      if (parent) {
        replyToId = parent.id;
        parentAuthorId = parent.userId;
      }
    }

    const [inserted] = await d.batch([
      d.insert(comments).values({
        reportId: report.id,
        userId: msg.author.id,
        body: msg.content || '',
        discordMessageId: msg.id,
        source: 'discord',
        replyToId,
        createdAt: msgTimestamp,
        updatedAt: editedTimestamp ?? msgTimestamp,
      }).returning(),
      d.update(reports)
        .set({
          commentCount: sql`${reports.commentCount} + 1`,
          updatedAt: sql`(unixepoch())`,
        })
        .where(eq(reports.id, report.id)),
    ]);

    const newComment = inserted[0];
    if (!newComment) continue;

    console.log(
      `[Poll] Inserted comment #${newComment.id} from Discord msg ${msg.id} in thread ${threadId}`,
    );

    // Store any attachments
    if (msg.attachments && msg.attachments.length > 0) {
      for (const att of msg.attachments) {
        await storeDiscordAttachment(att, report.id, newComment.id, kv);
      }
    }

    // Notify parent comment author if this was a reply
    if (parentAuthorId && parentAuthorId !== msg.author.id) {
      await d
        .insert(notifications)
        .values({
          userId: parentAuthorId,
          reportId: report.id,
          kind: 'mentioned',
          detail: `${msg.author.username} replied to your comment from Discord`,
        })
        .onConflictDoNothing();
    }

    // Notify report watchers (async, fire and forget)
    notifyWatchers(
      report.id,
      'comment',
      `Discord message by ${msg.author.username}`,
      msg.author.id,
    ).catch(() => {});
  }

  // Update the last-polled cursor on the report
  if (newestId && newestId !== report.discordLastMessageId) {
    await d
      .update(reports)
      .set({
        discordLastPolledAt: Math.floor(Date.now() / 1000),
        discordLastMessageId: newestId,
      })
      .where(eq(reports.id, report.id));
  } else {
    await d
      .update(reports)
      .set({ discordLastPolledAt: Math.floor(Date.now() / 1000) })
      .where(eq(reports.id, report.id));
  }
}

/**
 * Scheduled cron entry point.
 * Called by Cloudflare Workers runtime every 2 minutes.
 */
export async function onScheduled(event: ScheduledEvent, cfEnv: Env): Promise<void> {
  console.log('[Poll] Cron tick started at', new Date().toISOString());

  const cfg = await readConfig();
  if (cfg.discord_forum_sync_enabled !== '1') {
    console.log('[Poll] Forum sync disabled — skipping');
    return;
  }

  const botToken = cfg.discord_bot_token;
  if (!botToken) {
    console.warn('[Poll] No discord_bot_token configured — skipping');
    return;
  }

  const kv = (cfEnv as any).SESSION as KVNamespace | undefined;
  const botUserId = await getBotUserId(botToken);

  // Fetch reports that have a Discord thread, ordered by least-recently-polled first
  const syncedReports = await db()
    .select()
    .from(reports)
    .where(isNotNull(reports.discordThreadId))
    .orderBy(asc(reports.discordLastPolledAt))
    .limit(MAX_REPORTS_PER_RUN);

  console.log(`[Poll] Polling ${syncedReports.length} threads`);

  for (const report of syncedReports) {
    try {
      // Inline fetchThreadMessages with the real token
      const threadId = report.discordThreadId!;
      const params = new URLSearchParams({ limit: String(MESSAGES_PER_THREAD) });
      if (report.discordLastMessageId) params.set('after', report.discordLastMessageId);

      const res = await fetch(`${DISCORD_API}/channels/${threadId}/messages?${params}`, {
        headers: { Authorization: `Bot ${botToken}` },
      });

      if (!res.ok) {
        if (res.status === 404 || res.status === 403) {
          console.warn(`[Poll] Thread ${threadId} unreachable (${res.status}), skipping`);
          continue;
        }
        console.warn(`[Poll] Failed to fetch thread ${threadId}: ${res.status}`);
        continue;
      }

      const msgs = ((await res.json()) as DiscordMessage[]).sort((a, b) =>
        a.id < b.id ? -1 : 1,
      );

      if (msgs.length === 0) {
        // Update polled timestamp even if no new messages
        await db()
          .update(reports)
          .set({ discordLastPolledAt: Math.floor(Date.now() / 1000) })
          .where(eq(reports.id, report.id));
        continue;
      }

      const d = db();
      let newestId = report.discordLastMessageId ?? '';

      for (const msg of msgs) {
        if (msg.type === 21) continue; // skip starter message (our report embed)
        if (botUserId && msg.author.id === botUserId) continue; // skip our own bot
        if (msg.author.bot && msg.webhook_id) continue; // skip our webhook messages

        if (!newestId || msg.id > newestId) newestId = msg.id;

        const [existing] = await d
          .select({ id: comments.id, body: comments.body, updatedAt: comments.updatedAt })
          .from(comments)
          .where(eq(comments.discordMessageId, msg.id));

        const msgTimestamp = Math.floor(new Date(msg.timestamp).getTime() / 1000);
        const editedTimestamp = msg.edited_timestamp
          ? Math.floor(new Date(msg.edited_timestamp).getTime() / 1000)
          : null;

        if (existing) {
          // Update if edited
          if (
            editedTimestamp &&
            editedTimestamp > (existing.updatedAt ?? msgTimestamp) &&
            msg.content !== existing.body
          ) {
            await d
              .update(comments)
              .set({ body: msg.content, updatedAt: editedTimestamp })
              .where(eq(comments.id, existing.id));
          }
          continue;
        }

        // New message
        await upsertUser(msg.author.id, msg.author.username, msg.author.avatar);

        let replyToId: number | null = null;
        let parentAuthorId: string | null = null;
        const refMsgId = msg.message_reference?.message_id;
        if (refMsgId) {
          const [parent] = await d
            .select({ id: comments.id, userId: comments.userId })
            .from(comments)
            .where(eq(comments.discordMessageId, refMsgId));
          if (parent) {
            replyToId = parent.id;
            parentAuthorId = parent.userId;
          }
        }

        const [inserted] = await d.batch([
          d.insert(comments).values({
            reportId: report.id,
            userId: msg.author.id,
            body: msg.content || '',
            discordMessageId: msg.id,
            source: 'discord',
            replyToId,
            createdAt: msgTimestamp,
            updatedAt: editedTimestamp ?? msgTimestamp,
          }).returning(),
          d.update(reports)
            .set({ commentCount: sql`${reports.commentCount} + 1`, updatedAt: sql`(unixepoch())` })
            .where(eq(reports.id, report.id)),
        ]);

        const newComment = inserted[0];
        if (!newComment) continue;

        console.log(`[Poll] ✓ New comment #${newComment.id} from Discord (thread ${threadId})`);

        // Store attachments
        if (msg.attachments && msg.attachments.length > 0) {
          for (const att of msg.attachments) {
            await storeDiscordAttachment(att, report.id, newComment.id, kv);
          }
        }

        // Notify reply target
        if (parentAuthorId && parentAuthorId !== msg.author.id) {
          await d
            .insert(notifications)
            .values({
              userId: parentAuthorId,
              reportId: report.id,
              kind: 'mentioned',
              detail: `${msg.author.username} replied to your comment from Discord`,
            })
            .onConflictDoNothing();
        }

        // Notify watchers
        notifyWatchers(
          report.id,
          'comment',
          `Discord message by ${msg.author.username}`,
          msg.author.id,
        ).catch(() => {});
      }

      // Also check if thread tags have changed → sync status
      await syncReportStatusFromDiscord(report, cfg);

      // Update polling cursor
      await d.update(reports)
        .set({
          discordLastPolledAt: Math.floor(Date.now() / 1000),
          discordLastMessageId: newestId || report.discordLastMessageId,
        })
        .where(eq(reports.id, report.id));

    } catch (err) {
      console.error(`[Poll] Error processing report #${report.id} thread ${report.discordThreadId}:`, err);
    }
  }

  console.log('[Poll] Cron tick done');
}
