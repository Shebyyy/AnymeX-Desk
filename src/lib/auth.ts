import { env } from 'cloudflare:workers';
import type { APIContext, AstroGlobal } from 'astro';
import { eq, sql } from 'drizzle-orm';
import { db } from './db/client';
import { users, type StaffLevel, type User } from './db/schema';
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
      ...roleColumns,
    })
    .onConflictDoUpdate({
      target: users.discordId,
      set: {
        username: me.username,
        avatarHash: me.avatar,
        lastLogin: sql`(unixepoch())`,
        ...roleColumns,
      },
    })
    .returning({
      discordLevel: users.discordLevel,
      manualLevel: users.manualLevel,
      banned: users.banned,
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
  };
}

export async function currentUser(
  ctx: APIContext | AstroGlobal,
): Promise<SessionUser | null> {
  return (await ctx.session?.get('user')) ?? null;
}

/** The avatar URL Discord serves for this user, or null for the default one. */
export const avatarUrl = (u: { id: string; avatarHash: string | null }, size = 32) =>
  u.avatarHash
    ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatarHash}.png?size=${size}`
    : null;

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
