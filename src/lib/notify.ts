import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from './db/client';
import { inIds } from './db/sql';
import { notifications, reports, votes } from './db/schema';
import { readSetting } from './settings';

/**
 * Telling people what happened to the thing they reported or voted on.
 */

export type NotificationKind = 'status_changed' | 'comment' | 'duplicate' | 'mentioned';

/**
 * Notifies everyone invested in a report: the person who filed it and everyone
 * who voted. The actor is excluded.
 */
export async function notifyWatchers(
  reportId: number,
  kind: NotificationKind,
  detail: string | null,
  actorId: string | null,
) {
  const skip = actorId ?? '\0';
  await db().run(sql`
    INSERT INTO notifications (user_id, report_id, kind, detail)
    SELECT who, ${reportId}, ${kind}, ${detail} FROM (
      SELECT reporter_id AS who FROM reports WHERE id = ${reportId}
      UNION
      SELECT discord_id AS who FROM votes WHERE report_id = ${reportId}
    )
    WHERE who <> ${skip}
  `);
}

/** How many unread updates this person has. Cheap: covered by an index. */
export async function unreadCount(userId: string): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return row?.n ?? 0;
}

/** The columns a row needs. Deliberately not `select()` — `body` is large. */
const rowShape = {
  id: reports.id,
  kind: reports.kind,
  category: reports.category,
  platform: reports.platform,
  appVersion: reports.appVersion,
  title: reports.title,
  status: reports.status,
  votes: reports.votes,
  attachmentCount: reports.attachmentCount,
  commentCount: reports.commentCount,
  createdAt: reports.createdAt,
} as const;

/** What this person filed. */
export function myReports(userId: string, limit = 50) {
  return db()
    .select(rowShape)
    .from(reports)
    .where(eq(reports.reporterId, userId))
    .orderBy(desc(reports.createdAt))
    .limit(limit);
}

/** What this person backed but did not file. */
export function myBacked(userId: string, limit = 50) {
  return db()
    .select(rowShape)
    .from(votes)
    .innerJoin(reports, eq(reports.id, votes.reportId))
    .where(and(eq(votes.discordId, userId), sql`${reports.reporterId} <> ${userId}`))
    .orderBy(desc(votes.createdAt))
    .limit(limit);
}

/** The update feed, newest first. */
export async function myUpdates(userId: string, limit = 30) {
  const rows = await db()
    .select({
      id: notifications.id,
      kind: notifications.kind,
      detail: notifications.detail,
      createdAt: notifications.createdAt,
      readAt: notifications.readAt,
      reportId: reports.id,
      reportTitle: reports.title,
      reportStatus: reports.status,
      reportKind: reports.kind,
      reportCategory: reports.category,
      reportPlatform: reports.platform,
    })
    .from(notifications)
    .innerJoin(reports, eq(reports.id, notifications.reportId))
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
  return rows;
}

/** Marks the feed read. Called when the page is *left*, not when loaded. */
export async function markRead(userId: string, ids: number[]) {
  if (!ids.length) return;
  await db()
    .update(notifications)
    .set({ readAt: sql`(unixepoch())` })
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        inIds(notifications.id, ids),
      ),
    );
}

/* --- Discord DM notifications ------------------------------------------- */

const DISCORD_API = 'https://discord.com/api/v10';

/**
 * Send a DM to a Discord user via a bot token.
 *
 * The bot must share a guild with the target user, otherwise Discord returns
 * 403. This is best-effort: a failure is logged but never propagated.
 */
export async function sendDiscordDm(
  discordId: string,
  message: string,
): Promise<boolean> {
  const botToken = await readSetting('discord_bot_token');
  const dmEnabled = await readSetting('discord_dm_enabled');
  if (!botToken || (dmEnabled !== 'true' && dmEnabled !== '1')) {
    console.warn('[DM] Skipped: no token or disabled', { hasToken: !!botToken, dmEnabled });
    return false;
  }

  try {
    // Create or retrieve the DM channel.
    const dmRes = await fetch(`${DISCORD_API}/users/@me/channels`, {
      method: 'POST',
      headers: {
        authorization: `Bot ${botToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ recipient_id: discordId }),
    });
    if (!dmRes.ok) {
      console.error('[DM] Failed to create channel', { status: dmRes.status, body: await dmRes.text() });
      return false;
    }
    const dmChannel = (await dmRes.json()) as { id: string };

    // Send the message.
    const msgRes = await fetch(`${DISCORD_API}/channels/${dmChannel.id}/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bot ${botToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        content: message,
        allowed_mentions: { parse: [] },
      }),
    });
    if (!msgRes.ok) {
      console.error('[DM] Failed to send message', { status: msgRes.status, body: await msgRes.text() });
      return false;
    }
    console.log('[DM] Sent to', discordId);
    return true;
  } catch (err) {
    console.error('[DM] Exception', err);
    return false;
  }
}
