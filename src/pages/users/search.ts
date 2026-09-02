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
 * Requires sign-in so it can't be used as an open directory of every
 * Discord username that's ever touched the tracker.
 */
export const GET: APIRoute = async (ctx) => {
  const user = await currentUser(ctx);
  if (!user) return json({ error: 'sign-in' }, 401);

  const q = (ctx.url.searchParams.get('q') ?? '').trim().toLowerCase();
  if (q.length < 1) return json([]);

  const rows = await db()
    .select({ id: users.discordId, username: users.username, avatarHash: users.avatarHash })
    .from(users)
    .where(sql`lower(${users.username}) LIKE ${q + '%'} AND ${users.banned} = 0`)
    .orderBy(sql`length(${users.username}) asc`)
    .limit(8);

  return json(
    rows
      .filter((r) => r.id !== user.id)
      .map((r) => ({
        id: r.id,
        username: r.username,
        avatarUrl: avatarUrl({ id: r.id, avatarHash: r.avatarHash }, 20),
      })),
  );
};
