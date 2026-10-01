import type { APIRoute } from 'astro';
import { sql } from 'drizzle-orm';
import { currentUser, avatarUrl } from '../../lib/auth';
import { db } from '../../lib/db/client';
import { users } from '../../lib/db/schema';
import { isOwner } from '../../lib/staff';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * GET /users/search?q=par — for the @mention autocomplete dropdown.
 * Supports users, roles (@staff, @admin, @mod), and @everyone.
 */
export const GET: APIRoute = async (ctx) => {
  const user = await currentUser(ctx);
  const q = (ctx.url.searchParams.get('q') ?? '').trim().toLowerCase();

  // Special role mentions
  const SPECIAL_MENTIONS = [
    { id: 'role-everyone', username: 'everyone', subtitle: 'Notify all members in channel', role: 'everyone' },
    { id: 'role-here', username: 'here', subtitle: 'Notify active members', role: 'here' },
    { id: 'role-staff', username: 'staff', subtitle: 'Notify moderators & admins', role: 'staff' },
    { id: 'role-mod', username: 'mod', subtitle: 'Notify moderators', role: 'mod' },
    { id: 'role-admin', username: 'admin', subtitle: 'Notify administrators', role: 'admin' },
  ];

  const matchedSpecial = SPECIAL_MENTIONS.filter(
    (s) => !q || s.username.toLowerCase().includes(q) || (s.subtitle && s.subtitle.toLowerCase().includes(q)),
  );

  const whereClause = q
    ? sql`(lower(${users.username}) LIKE ${'%' + q + '%'}) AND ${users.banned} = 0`
    : sql`${users.banned} = 0`;

  const rows = await db()
    .select({
      id: users.discordId,
      username: users.username,
      avatarHash: users.avatarHash,
      discordLevel: users.discordLevel,
      manualLevel: users.manualLevel,
    })
    .from(users)
    .where(whereClause)
    .orderBy(
      q
        ? sql`CASE WHEN lower(${users.username}) = ${q} THEN 0 WHEN lower(${users.username}) LIKE ${q + '%'} THEN 1 ELSE 2 END, length(${users.username}) asc`
        : sql`length(${users.username}) asc`
    )
    .limit(50);

  const userItems = rows
    .filter((r) => !user || r.id !== user.id)
    .map((r) => {
      const role = isOwner(r.id) ? 'owner' : r.manualLevel || r.discordLevel || 'member';
      return {
        id: r.id,
        username: r.username,
        avatarUrl: avatarUrl({ id: r.id, avatarHash: r.avatarHash }, 24),
        role,
      };
    });

  return json([...matchedSpecial, ...userItems]);
};