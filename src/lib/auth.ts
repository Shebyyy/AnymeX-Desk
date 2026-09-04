import { env } from 'cloudflare:workers';
import type { APIContext, AstroGlobal } from 'astro';
import { eq, sql } from 'drizzle-orm';
import { db } from './db/client';
import {
  users,
  reports,
  comments,
  votes,
  notifications,
  subscriptions,
  commentReactions,
  type StaffLevel,
  type User,
} from './db/schema';
import { combine, type Level } from './levels';
import { idList, readConfig, readSetting } from './settings';

export interface SessionUser {
  id: string;
  username: string;
  avatarHash: string | null;
  accountCreatedAt: number;
  /**
   * Staff level as it stood at login, for deciding what to *show*. Never for
   * deciding what to allow: every privileged action re-reads the level from
   * D1 (see lib/staff.ts).
   */
  level: Level;
  /**
   * The role ids this member holds in the guild, captured at login (if
   * available). Shown in the dashboard because role *names* need a bot.
   */
  guildRoles: string[];
  /**
   * Passed the whole write gate at login, for deciding what to *show* — a
   * "report this" button, a vote control. Never for deciding what to allow:
   * use `canWriteNow`.
   */
  canWrite: boolean;
  /** Linked Telegram ID if connected */
  telegramId?: string | null;
  /** Linked Telegram Username if connected */
  telegramUsername?: string | null;
  /** Whether Discord is actively connected */
  discordLinked?: boolean;
}

const DISCORD_API = 'https://discord.com/api/v10';
const SCOPES = ['identify'];

/** Discord snowflakes encode creation time — no extra scope, no API call. */
export function snowflakeCreatedAt(id: string): number {
  return Number((BigInt(id) >> 22n) + 1_420_070_400_000n) / 1000;
}

export const authorizeUrl = (state: string, redirectUri: string) =>
  `${DISCORD_API.replace('/api/v10', '')}/oauth2/authorize?` +
  new URLSearchParams({
    client_id: String(env.DISCORD_CLIENT_ID),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    prompt: 'none',
  });

export async function exchangeCode(code: string, redirectUri: string) {
  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: String(env.DISCORD_CLIENT_ID),
      client_secret: String(env.DISCORD_CLIENT_SECRET),
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { access_token: string };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * Builds the session user and decides whether they may write.
 *
 * AnymeX users do not need to be in a Discord guild to file reports.
 * Anyone with a Discord account can participate.
 *
 * Guild membership and role resolution is attempted if DISCORD_GUILD_ID is
 * set, purely for staff level detection. It is not a write gate.
 */
export async function buildSessionUser(token: string): Promise<SessionUser> {
  const [meRes, cfg] = await Promise.all([
    fetch(`${DISCORD_API}/users/@me`, { headers: bearer(token) }),
    readConfig(),
  ]);

  if (!meRes.ok) {
    throw new Error(`discord /users/@me failed: ${meRes.status} ${await meRes.text()}`);
  }
  const me = (await meRes.json()) as {
    id: string;
    username: string;
    avatar: string | null;
  };

  const minAgeDays = Number(cfg.min_account_age_days || 30);
  const accountCreatedAt = snowflakeCreatedAt(me.id);
  const ageDays = (Date.now() / 1000 - accountCreatedAt) / 86_400;

  let discordLevel: StaffLevel | null = null;
  let roles: string[] = [];
  let joinedAt: number | null = null;
  let rolesResolved = false;

  // Optionally resolve guild roles for staff detection. Not required for writes.
  const guildId = env.DISCORD_GUILD_ID ? String(env.DISCORD_GUILD_ID) : '';
  if (guildId) {
    try {
      const guildsRes = await fetch(`${DISCORD_API}/users/@me/guilds`, { headers: bearer(token) });
      if (guildsRes.ok) {
        const guilds = (await guildsRes.json()) as { id: string }[];
        const inGuild = Array.isArray(guilds) && guilds.some((g) => g.id === guildId);
        if (inGuild) {
          const memberRes = await fetch(`${DISCORD_API}/users/@me/guilds/${guildId}/member`, {
            headers: bearer(token),
          });
          if (memberRes.ok) {
            rolesResolved = true;
            const member = (await memberRes.json()) as { roles: string[]; joined_at: string };
            roles = member.roles ?? [];
            const admins = idList(cfg.admin_role_ids);
            const mods = idList(cfg.mod_role_ids);
            if (roles.some((r) => admins.includes(r))) discordLevel = 'admin';
            else if (roles.some((r) => mods.includes(r))) discordLevel = 'mod';
            joinedAt = member.joined_at ? Math.floor(new Date(member.joined_at).getTime() / 1000) : null;
          }
        } else {
          // Not in guild — no roles to resolve, but this is a real answer.
          rolesResolved = true;
        }
      }
    } catch {
      // Guild resolution failure must not block login.
    }
  }

  const roleColumns = rolesResolved ? { discordLevel, guildJoinedAt: joinedAt } : {};

  const [row] = await db()
    .insert(users)
    .values({
      discordId: me.id,
      username: me.username,
      avatarHash: me.avatar,
      accountCreatedAt: Math.floor(accountCreatedAt),
      discordLinked: true,
      discordUserId: me.id,
      ...roleColumns,
    })
    .onConflictDoUpdate({
      target: users.discordId,
      set: {
        username: me.username,
        avatarHash: me.avatar,
        discordLinked: true,
        discordUserId: me.id,
        lastLogin: sql`(unixepoch())`,
        lastSeen: sql`(unixepoch())`,
        ...roleColumns,
      },
    })
    .returning({
      discordLevel: users.discordLevel,
      manualLevel: users.manualLevel,
      banned: users.banned,
      telegramId: users.telegramId,
      telegramUsername: users.telegramUsername,
      discordLinked: users.discordLinked,
    });

  const owner = !!env.OWNER_DISCORD_ID && String(env.OWNER_DISCORD_ID).trim() === me.id;

  // AnymeX: anyone with a Discord account can write (no guild requirement).
  return {
    id: me.id,
    username: me.username,
    avatarHash: me.avatar,
    accountCreatedAt,
    level: owner ? 'owner' : combine(row?.discordLevel ?? null, row?.manualLevel ?? null),
    guildRoles: roles,
    canWrite: !row?.banned && ageDays >= minAgeDays,
    telegramId: row?.telegramId ?? null,
    telegramUsername: row?.telegramUsername ?? null,
    discordLinked: true,
  };
}

/**
 * Builds the session user for a user authenticated via Telegram Login.
 * If an existing user has this telegramId linked, it signs into that user.
 * Otherwise, creates a new user account with `discordId = tg:<telegram_id>`.
 */
export async function buildTelegramSessionUser(tgUser: {
  id: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
}): Promise<SessionUser> {
  const d = db();
  const telegramId = String(tgUser.id);
  const internalId = `tg:${telegramId}`;
  const fullName = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ').trim();
  const displayName = fullName || tgUser.username || `Telegram User ${telegramId.slice(-4)}`;
  const avatar = tgUser.photo_url || null;

  // Check if existing user is already linked with this telegramId
  const [existing] = await d
    .select()
    .from(users)
    .where(eq(users.telegramId, telegramId));

  let finalUserId = internalId;
  let userRow = existing;

  if (existing) {
    finalUserId = existing.discordId;
    const [updated] = await d
      .update(users)
      .set({
        telegramUsername: tgUser.username || existing.telegramUsername,
        telegramPhotoUrl: avatar || existing.telegramPhotoUrl,
        lastLogin: sql`(unixepoch())`,
        lastSeen: sql`(unixepoch())`,
      })
      .where(eq(users.discordId, existing.discordId))
      .returning();
    userRow = updated;
  } else {
    // Create new user for this Telegram account
    const now = Math.floor(Date.now() / 1000);
    const [inserted] = await d
      .insert(users)
      .values({
        discordId: internalId,
        username: displayName,
        avatarHash: avatar,
        accountCreatedAt: now,
        telegramId,
        telegramUsername: tgUser.username || null,
        telegramPhotoUrl: avatar,
        firstSeen: now,
        lastLogin: now,
        lastSeen: now,
      })
      .returning();
    userRow = inserted;
  }

  const owner = !!env.OWNER_DISCORD_ID && String(env.OWNER_DISCORD_ID).trim() === finalUserId;

  return {
    id: finalUserId,
    username: userRow?.username || displayName,
    avatarHash: userRow?.telegramPhotoUrl || userRow?.avatarHash || null,
    accountCreatedAt: userRow?.accountCreatedAt || Math.floor(Date.now() / 1000),
    level: owner ? 'owner' : combine(userRow?.discordLevel ?? null, userRow?.manualLevel ?? null),
    guildRoles: [],
    canWrite: !userRow?.banned,
    telegramId,
    telegramUsername: userRow?.telegramUsername || tgUser.username || null,
    discordLinked: userRow?.discordLinked !== false && !finalUserId.startsWith('tg:'),
  };
}

export async function currentUser(
  ctx: APIContext | AstroGlobal,
): Promise<SessionUser | null> {
  return (await ctx.session?.get('user')) ?? null;
}

/** The avatar URL Discord or Telegram serves for this user, or null for the default one. */
export const avatarUrl = (u: { id: string; avatarHash: string | null }, size = 32) => {
  if (!u.avatarHash) return null;
  if (u.avatarHash.startsWith('http://') || u.avatarHash.startsWith('https://')) {
    return u.avatarHash;
  }
  return `https://cdn.discordapp.com/avatars/${u.id}/${u.avatarHash}.png?size=${size}`;
};

/**
 * Why this visitor may not write, or null if they may.
 *
 * `sign-in` — nobody is signed in.
 * `banned`  — blocked by hand in the dashboard.
 * `age`     — account younger than the current threshold.
 *
 * Note: `guild` is no longer a block reason for AnymeX.
 */
export type WriteBlock = 'sign-in' | 'banned' | 'age';

/**
 * The single place that decides whether a write is allowed, and says why not.
 *
 * Ban and age are re-read from D1 on every write so a revocation takes effect
 * immediately.
 */
export async function writeBlockReason(u: SessionUser | null): Promise<WriteBlock | null> {
  if (!u) return 'sign-in';

  const [row] = await db()
    .select({ banned: users.banned })
    .from(users)
    .where(eq(users.discordId, u.id));
  if (!row || row.banned) return 'banned';

  const minAgeDays = Number((await readSetting('min_account_age_days')) || 30);
  const ageDays = (Date.now() / 1000 - u.accountCreatedAt) / 86_400;
  return ageDays < minAgeDays ? 'age' : null;
}

/**
 * May this user write *right now*? Call this on every write path.
 */
export async function canWriteNow(user: SessionUser): Promise<boolean> {
  return (await writeBlockReason(user)) === null;
}

export async function dbUser(discordId: string): Promise<User | undefined> {
  const [row] = await db().select().from(users).where(eq(users.discordId, discordId));
  return row;
}

/**
 * Merges a secondary user account into a primary user account.
 * Migrates reports, comments, votes, reactions, notifications, subscriptions,
 * updates the primary user's linked credentials, and safely deletes the secondary user row.
 */
export async function mergeUserAccounts(
  fromUserId: string,
  toUserId: string,
  telegramData?: {
    telegramId?: string | null;
    telegramUsername?: string | null;
    telegramPhotoUrl?: string | null;
  },
) {
  const d = db();
  if (!fromUserId || !toUserId || fromUserId === toUserId) return;

  try {
    // 1. Move reports
    await d.update(reports).set({ reporterId: toUserId }).where(eq(reports.reporterId, fromUserId));
  } catch (e) {
    console.warn('[merge] moving reports:', e);
  }

  try {
    // 2. Move comments
    await d.update(comments).set({ userId: toUserId }).where(eq(comments.userId, fromUserId));
  } catch (e) {
    console.warn('[merge] moving comments:', e);
  }

  try {
    // 3. Move notifications
    await d.update(notifications).set({ userId: toUserId }).where(eq(notifications.userId, fromUserId));
  } catch (e) {
    console.warn('[merge] moving notifications:', e);
  }

  try {
    // 4. Move subscriptions
    await d.update(subscriptions).set({ userId: toUserId }).where(eq(subscriptions.userId, fromUserId));
  } catch (e) {
    console.warn('[merge] moving subscriptions:', e);
  }

  try {
    // 5. Move votes (de-duplicate against existing toUserId votes)
    await d.run(sql`
      DELETE FROM votes
      WHERE discord_id = ${fromUserId}
        AND report_id IN (SELECT report_id FROM votes WHERE discord_id = ${toUserId})
    `);
    await d.run(sql`
      UPDATE votes SET discord_id = ${toUserId} WHERE discord_id = ${fromUserId}
    `);
  } catch (e) {
    console.warn('[merge] moving votes:', e);
  }

  try {
    // 6. Move reactions (de-duplicate against existing toUserId reactions)
    await d.run(sql`
      DELETE FROM comment_reactions
      WHERE discord_id = ${fromUserId}
        AND (comment_id, emoji) IN (
          SELECT comment_id, emoji FROM comment_reactions WHERE discord_id = ${toUserId}
        )
    `);
    await d.run(sql`
      UPDATE comment_reactions SET discord_id = ${toUserId} WHERE discord_id = ${fromUserId}
    `);
  } catch (e) {
    console.warn('[merge] moving reactions:', e);
  }

  try {
    // 7. Clear telegram credentials from fromUserId so they don't collide
    await d
      .update(users)
      .set({ telegramId: null, telegramUsername: null, telegramPhotoUrl: null })
      .where(eq(users.discordId, fromUserId));

    // 8. Update toUserId with Telegram details if provided
    if (telegramData?.telegramId) {
      await d
        .update(users)
        .set({
          telegramId: telegramData.telegramId,
          telegramUsername: telegramData.telegramUsername || null,
          telegramPhotoUrl: telegramData.telegramPhotoUrl || null,
          notifyTelegram: true,
          discordLinked: true,
          discordUserId: toUserId.startsWith('tg:') ? null : toUserId,
          lastLogin: sql`(unixepoch())`,
        })
        .where(eq(users.discordId, toUserId));
    }

    // 9. Safely remove fromUserId now that everything is migrated
    await d.delete(users).where(eq(users.discordId, fromUserId));
  } catch (e) {
    console.warn('[merge] finalizing user records:', e);
  }
}

