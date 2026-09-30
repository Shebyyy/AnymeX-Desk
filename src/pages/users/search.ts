import type { APIRoute } from 'astro';
import { sql } from 'drizzle-orm';
import { currentUser, avatarUrl } from '../../lib/auth';
import { db } from '../../lib/db/client';
import { users } from '../../lib/db/schema';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * GET /users/search?q=par — for the @mention autocomplete dropdown.
 * If q is empty, returns recent/first users for immediate suggestion.
 */
export const GET: APIRoute = async (ctx) => {
  const user = await currentUser(ctx);
  if (!user) return json({ error: 'sign-in' }, 401);

  const q = (ctx.url.searchParams.get('q') ?? '').trim().toLowerCase();

  const whereClause = q
    ? sql`lower(${users.username}) LIKE ${q + '%'} AND ${users.banned} = 0`
    : sql`${users.banned} = 0`;

  const rows = await db()
    .select({ id: users.discordId, username: users.username, avatarHash: users.avatarHash })
    .from(users)
    .where(whereClause)
    .orderBy(sql`length(${users.username}) asc`)
    .limit(10);

  return json(
    rows
      .filter((r) => r.id !== user.id)
      .map((r) => ({
        id: r.id,
        username: r.username,
        avatarUrl: avatarUrl({ id: r.id, avatarHash: r.avatarHash }, 24),
      })),
  );
};