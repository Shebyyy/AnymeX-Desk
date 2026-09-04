import type { APIRoute } from 'astro';
import { eq, or, sql } from 'drizzle-orm';
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
    const userMatch = user.telegramId
      ? or(eq(users.discordId, user.id), eq(users.telegramId, user.telegramId))
      : eq(users.discordId, user.id);

    const [row] = await db()
      .select({ lastSeen: users.lastSeen, discordId: users.discordId })
      .from(users)
      .where(userMatch)
      .limit(1);

    if (row) {
      if (!row.lastSeen || now - row.lastSeen > 30) {
        await db()
          .update(users)
          .set({ lastSeen: now })
          .where(eq(users.discordId, row.discordId));
      }
    } else {
      await db()
        .insert(users)
        .values({
          discordId: user.id,
          username: user.username,
          avatarHash: user.avatarHash,
          lastLogin: now,
          lastSeen: now,
          accountCreatedAt: user.accountCreatedAt || now,
          telegramId: user.telegramId || null,
        })
        .onConflictDoUpdate({
          target: users.discordId,
          set: { lastSeen: now },
        });
    }

    return new Response(JSON.stringify({ ok: true, now, status: 'online' }), {
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
