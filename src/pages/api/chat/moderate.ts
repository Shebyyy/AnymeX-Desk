import type { APIRoute } from 'astro';
import { db } from '../../../lib/db/client';
import { users, chatModerationLogs } from '../../../lib/db/schema';
import { currentUser } from '../../../lib/auth';
import { levelOf, atLeast } from '../../../lib/staff';
import { eq, sql } from 'drizzle-orm';

export const prerender = false;

function parseDuration(val: string | number | undefined): number {
  if (typeof val === 'number') return val;
  if (!val) return 3600; // default 1 hour
  const str = val.trim().toLowerCase();
  const match = str.match(/^(\d+)\s*([mhdws]?)$/);
  if (!match) return 3600;
  const num = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 'm':
      return num * 60;
    case 'h':
      return num * 3600;
    case 'd':
      return num * 86400;
    case 'w':
      return num * 604800;
    case 's':
      return num;
    default:
      return num * 60; // default minutes if just number
  }
}

export const POST: APIRoute = async (ctx) => {
  const staff = await currentUser(ctx);
  if (!staff) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const staffRole = await levelOf(staff.id);
  if (!atLeast(staffRole, 'mod')) {
    return new Response(JSON.stringify({ ok: false, error: 'Forbidden: Staff only' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await ctx.request.json();
    const { action, targetId, targetUsername, reason, duration } = body || {};

    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      return new Response(JSON.stringify({ ok: false, error: 'A moderation reason is strictly required.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const trimmedReason = reason.trim().slice(0, 500);

    // Resolve target user
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
      return new Response(JSON.stringify({ ok: false, error: 'Target user not found.' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Prevent staff from moderating themselves or higher staff
    if (target.discordId === staff.id) {
      return new Response(JSON.stringify({ ok: false, error: 'You cannot moderate yourself.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const targetRole = await levelOf(target.discordId);
    if (atLeast(targetRole, staffRole) && staffRole !== 'owner') {
      return new Response(JSON.stringify({ ok: false, error: 'You cannot moderate equal or higher staff members.' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const durationSeconds = action === 'timeout' ? parseDuration(duration) : null;
    const nowSec = Math.floor(Date.now() / 1000);

    if (action === 'timeout') {
      const timedOutUntil = nowSec + (durationSeconds || 3600);
      await db()
        .update(users)
        .set({
          timedOutUntil,
          timeoutReason: trimmedReason,
        })
        .where(eq(users.discordId, target.discordId));
    } else if (action === 'untimeout') {
      await db()
        .update(users)
        .set({
          timedOutUntil: null,
          timeoutReason: null,
        })
        .where(eq(users.discordId, target.discordId));
    } else if (action === 'ban') {
      await db()
        .update(users)
        .set({
          chatBanned: true,
          chatBanReason: trimmedReason,
        })
        .where(eq(users.discordId, target.discordId));
    } else if (action === 'unban') {
      await db()
        .update(users)
        .set({
          chatBanned: false,
          chatBanReason: null,
        })
        .where(eq(users.discordId, target.discordId));
    } else if (action === 'warn') {
      // Warn records an official staff warning in chatModerationLogs
    } else {
      return new Response(JSON.stringify({ ok: false, error: `Invalid action: ${action}` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Record moderation log
    await db().insert(chatModerationLogs).values({
      targetUserId: target.discordId,
      actorUserId: staff.id,
      action,
      reason: trimmedReason,
      durationSeconds,
    });

    return new Response(
      JSON.stringify({
        ok: true,
        message: `Successfully executed ${action} on @${target.username}.`,
        target: {
          id: target.discordId,
          username: target.username,
          action,
          reason: trimmedReason,
          durationSeconds,
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  } catch (err: any) {
    console.error('[chat:moderate] Error:', err);
    return new Response(JSON.stringify({ ok: false, error: err?.message || 'Moderation failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
