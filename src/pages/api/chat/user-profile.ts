import type { APIRoute } from 'astro';
import { db } from '../../../lib/db/client';
import { users, chatModerationLogs } from '../../../lib/db/schema';
import { currentUser, avatarUrl } from '../../../lib/auth';
import { levelOf, atLeast, isOwner } from '../../../lib/staff';
import { eq, desc, sql } from 'drizzle-orm';

export const prerender = false;

export const GET: APIRoute = async (ctx) => {
  const viewer = await currentUser(ctx);
  const url = new URL(ctx.request.url);
  const targetId = url.searchParams.get('id');
  const targetUsername = url.searchParams.get('username');

  if (!targetId && !targetUsername) {
    return new Response(JSON.stringify({ ok: false, error: 'User ID or username is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    let target = null;
    if (targetId) {
      const [u] = await db().select().from(users).where(eq(users.discordId, targetId)).limit(1);
      target = u;
    } else if (targetUsername) {
      const cleanName = targetUsername.startsWith('@') ? targetUsername.slice(1).trim() : targetUsername.trim();
      const [u] = await db()
        .select()
        .from(users)
        .where(sql`lower(${users.username}) = lower(${cleanName})`)
        .limit(1);
      target = u;
    }

    if (!target) {
      return new Response(JSON.stringify({ ok: false, error: 'User not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const viewerRole = viewer ? await levelOf(viewer.id) : 'user';
    const isStaff = atLeast(viewerRole, 'mod');
    const targetRole = isOwner(target.discordId)
      ? 'owner'
      : target.manualLevel || target.discordLevel || 'member';

    const nowSec = Math.floor(Date.now() / 1000);
    const isTimedOut = typeof target.timedOutUntil === 'number' && target.timedOutUntil > nowSec;

    // Fetch moderation logs if viewer is staff
    let logs: any[] = [];
    if (isStaff) {
      const rawLogs = await db()
        .select({
          id: chatModerationLogs.id,
          action: chatModerationLogs.action,
          reason: chatModerationLogs.reason,
          durationSeconds: chatModerationLogs.durationSeconds,
          createdAt: chatModerationLogs.createdAt,
          actorName: users.username,
        })
        .from(chatModerationLogs)
        .leftJoin(users, eq(users.discordId, chatModerationLogs.actorUserId))
        .where(eq(chatModerationLogs.targetUserId, target.discordId))
        .orderBy(desc(chatModerationLogs.createdAt))
        .limit(10);

      logs = rawLogs;
    }

    return new Response(
      JSON.stringify({
        ok: true,
        user: {
          id: target.discordId,
          username: target.username,
          avatarUrl: avatarUrl({ id: target.discordId, avatarHash: target.avatarHash }, 128),
          role: targetRole,
          accountCreatedAt: target.accountCreatedAt,
          firstSeen: target.firstSeen,
          chatBanned: !!target.chatBanned,
          chatBanReason: target.chatBanReason || null,
          timedOutUntil: target.timedOutUntil || null,
          timeoutReason: target.timeoutReason || null,
          isTimedOut,
        },
        logs,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  } catch (err: any) {
    console.error('[chat:user-profile] Error:', err);
    return new Response(JSON.stringify({ ok: false, error: err?.message || 'Failed fetching profile' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
