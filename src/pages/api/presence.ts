import type { APIRoute } from 'astro';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../lib/db/client';
import { users } from '../../lib/db/schema';
import { currentUser } from '../../lib/auth';

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const user = await currentUser(ctx);
  if (!user) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const now = Math.floor(Date.now() / 1000);

  try {
    // Throttle D1 writes: only update if last_seen was > 90 seconds ago
    const [row] = await db()
      .select({ lastSeen: users.lastSeen })
      .from(users)
      .where(eq(users.discordId, user.id));

    if (!row?.lastSeen || now - row.lastSeen > 90) {
      await db()
        .update(users)
        .set({ lastSeen: now })
        .where(eq(users.discordId, user.id));
    }

    return new Response(JSON.stringify({ ok: true, now }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[presence:ping] Error updating last_seen:', err);
    return new Response(JSON.stringify({ ok: false }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
