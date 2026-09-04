import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import { db } from '../../lib/db/client';
import { users } from '../../lib/db/schema';
import { snowflakeCreatedAt as snowflake } from '../../lib/auth';

export const prerender = false;

export const GET: APIRoute = async (ctx) => {
  const k = ctx.url.searchParams.get('k') ?? '';
  const expected = String(env.DISCORD_SYNC_SECRET ?? '').trim();
  if (!expected || k !== expected) return new Response('forbidden', { status: 403 });
  const ownerId = String(env.OWNER_DISCORD_ID ?? '').trim();
  if (!ownerId) return new Response('OWNER_DISCORD_ID not configured', { status: 500 });
  const [row] = await db().insert(users).values({ discordId: ownerId, username: 'owner', accountCreatedAt: snowflake(ownerId), manualLevel: 'admin', discordLinked: true, discordUserId: ownerId }).onConflictDoUpdate({ target: users.discordId, set: { manualLevel: 'admin', lastLogin: sql`(unixepoch())`, lastSeen: sql`(unixepoch())` } }).returning({ discordId: users.discordId, username: users.username, avatarHash: users.avatarHash, accountCreatedAt: users.accountCreatedAt, discordLevel: users.discordLevel, manualLevel: users.manualLevel, banned: users.banned, telegramId: users.telegramId, telegramUsername: users.telegramUsername, discordLinked: users.discordLinked });
  if (!row) return new Response('owner row missing', { status: 500 });
  const sessionUser = { id: row.discordId, username: row.username, avatarHash: row.avatarHash, accountCreatedAt: row.accountCreatedAt, level: 'owner' as const, guildRoles: [], canWrite: !row.banned, telegramId: row.telegramId, telegramUsername: row.telegramUsername, discordLinked: row.discordLinked };
  await ctx.session?.regenerate();
  await ctx.session?.set('user', sessionUser);
  ctx.cookies.set('signed_in', '1', { path: '/', httpOnly: false, secure: ctx.url.protocol === 'https:', sameSite: 'lax', maxAge: 60 * 60 * 24 * 30 });
  const next = ctx.url.searchParams.get('next') ?? '/';
  const safe = next.startsWith('/') && !next.startsWith('//') ? next : '/';
  return ctx.redirect(safe, 302);
};
