import { env } from 'cloudflare:workers';
import type { APIContext, AstroGlobal } from 'astro';
import { eq, sql } from 'drizzle-orm';
import { db } from './db/client';
import { audit, users, type StaffLevel } from './db/schema';
import { atLeast, combine as combineLevels, type Level } from './levels';
import { currentUser, type SessionUser } from './auth';
import { readSetting } from './settings';
import { send, GREEN, RED } from './webhook';

export { atLeast, combine, LEVEL_LABELS, type Level } from './levels';

/**
 * Who may do what.
 *
 * The session carries a level for *display* only. Every privileged action
 * re-reads it from D1, because a session is a snapshot: without the re-read, a
 * grant would not apply until the person logged in again, and — much worse — a
 * revocation would not apply until they chose to.
 */

export const isOwner = (discordId: string) =>
  !!env.OWNER_DISCORD_ID && String(env.OWNER_DISCORD_ID).trim() === discordId;

/** Authoritative level, read fresh. Owner outranks whatever the table says. */
export async function levelOf(discordId: string): Promise<Level> {
  if (isOwner(discordId)) return 'owner';
  const [row] = await db()
    .select({ discordLevel: users.discordLevel, manualLevel: users.manualLevel })
    .from(users)
    .where(eq(users.discordId, discordId));
  if (!row) return 'user';
  return combineLevels(row.discordLevel, row.manualLevel);
}

export interface StaffContext {
  user: SessionUser;
  level: Level;
}

/**
 * Gate for a page or route. Returns the caller when they clear `needed`, or a
 * Response to return as-is — 404 rather than 403 for a non-staff visitor,
 * since the existence of the dashboard is not their business.
 */
export async function requireStaff(
  ctx: APIContext | AstroGlobal,
  needed: Level = 'mod',
): Promise<StaffContext | Response> {
  const user = await currentUser(ctx);
  if (!user) {
    const to = new URL(ctx.request.url).pathname;
    return ctx.redirect(`/auth/discord?next=${encodeURIComponent(to)}`, 302);
  }
  const level = await levelOf(user.id);
  if (!atLeast(level, needed)) return new Response('Not found', { status: 404 });
  return { user, level };
}

export const isResponse = (v: unknown): v is Response => v instanceof Response;

/**
 * `Pick` rather than `SessionUser`, so any actor that holds id + username
 * can be logged — staff actions, automations, etc.
 *
 * Every call writes to the `audit` table (source of truth, shown on the
 * admin dashboard) and, if the announcement webhook is configured, also
 * posts the same event as an embed to that channel — with a link back to
 * the report when one is given. The webhook post is best-effort: it never
 * blocks or fails the caller's action, it just won't have a Discord copy if
 * the webhook is down or unset.
 */
const ACTION_META: Record<string, { label: string; color?: number }> = {
  'vote.add': { label: 'Vote added', color: GREEN },
  'vote.remove': { label: 'Vote removed' },
  'comment.add': { label: 'New comment' },
  'comment.reply': { label: 'New reply' },
  'comment.edit': { label: 'Comment edited' },
  'comment.delete': { label: 'Comment deleted', color: RED },
  'report.file': { label: 'Report filed', color: GREEN },
  'report.join_duplicate': { label: 'Joined duplicate report' },
  'report.status': { label: 'Status changed' },
  'report.duplicate': { label: 'Marked duplicate' },
  'report.delete': { label: 'Report deleted', color: RED },
  'attachment.pin': { label: 'Attachment pinned' },
  'settings.roles': { label: 'Role mapping updated' },
  'settings.gate': { label: 'Account-age gate updated' },
  'settings.webhook': { label: 'Announcement settings updated' },
  'settings.dm': { label: 'DM settings updated' },
  'user.block': { label: 'User blocked', color: RED },
  'user.unblock': { label: 'User unblocked', color: GREEN },
  'staff.grant': { label: 'Staff granted', color: GREEN },
  'staff.revoke': { label: 'Staff revoked', color: RED },
};

export async function logAction(
  actor: Pick<SessionUser, 'id' | 'username'>,
  action: string,
  target?: string | null,
  detail?: string | null,
  url?: string | null,
) {
  await db()
    .insert(audit)
    .values({
      actorId: actor.id,
      actorName: actor.username,
      action,
      target: target ?? null,
      detail: detail ?? null,
    });

  try {
    const webhookUrl = await readSetting('webhook_url');
    if (!webhookUrl) return;
    const meta = ACTION_META[action];
    const fields: { name: string; value: string; inline?: boolean }[] = [
      { name: 'By', value: actor.username, inline: true },
    ];
    if (target) fields.push({ name: 'Target', value: target, inline: true });
    await send(webhookUrl, {
      title: meta?.label ?? action,
      description: detail ?? undefined,
      url: url ?? undefined,
      color: meta?.color,
      fields,
    });
  } catch (err) {
    console.error('[log webhook] failed to post', err);
  }
}

/** Grant or clear a manual level. Clearing passes null. */
export async function setManualLevel(discordId: string, level: StaffLevel | null) {
  await db()
    .update(users)
    .set({ manualLevel: level, lastLogin: sql`${users.lastLogin}` })
    .where(eq(users.discordId, discordId));
}
