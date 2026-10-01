import type { APIRoute } from 'astro';
import { db } from '../../../lib/db/client';
import { chatMessages, chatChannels, users, chatModerationLogs } from '../../../lib/db/schema';
import { currentUser } from '../../../lib/auth';
import { levelOf, atLeast } from '../../../lib/staff';
import { inIds } from '../../../lib/db/sql';
import { eq, desc, and, sql } from 'drizzle-orm';

export const prerender = false;

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
    const channelId = String(body?.channelId || 'general').trim();
    let count = Math.min(Math.max(parseInt(body?.count, 10) || 10, 1), 100);
    const targetUsername = body?.targetUsername ? String(body.targetUsername).trim() : null;
    let targetUserId = body?.targetUserId ? String(body.targetUserId).trim() : null;

    // Resolve target username if provided (e.g. /purge @spammer 10)
    if (!targetUserId && targetUsername) {
      const cleanName = targetUsername.startsWith('@') ? targetUsername.slice(1).trim() : targetUsername.trim();
      const [u] = await db()
        .select()
        .from(users)
        .where(sql`lower(${users.username}) = lower(${cleanName})`)
        .limit(1);
      if (u) {
        targetUserId = u.discordId;
      } else {
        return new Response(JSON.stringify({ ok: false, error: `Target user "${targetUsername}" not found.` }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Select IDs of messages to purge
    let whereClause = eq(chatMessages.channelId, channelId);
    if (targetUserId) {
      whereClause = and(eq(chatMessages.channelId, channelId), eq(chatMessages.userId, targetUserId)) as any;
    }

    const messagesToPurge = await db()
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(whereClause)
      .orderBy(desc(chatMessages.id))
      .limit(count);

    if (messagesToPurge.length === 0) {
      return new Response(
        JSON.stringify({
          ok: true,
          deletedCount: 0,
          message: targetUsername
            ? `No messages from @${targetUsername.replace(/^@/, '')} found to purge in this channel.`
            : 'No messages found to purge in this channel.',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const idsToDelete = messagesToPurge.map((m) => m.id);

    // Delete messages (reactions cascade delete)
    await db().delete(chatMessages).where(inIds(chatMessages.id, idsToDelete));

    // Log moderation action
    await db().insert(chatModerationLogs).values({
      targetUserId: targetUserId || null,
      actorUserId: staff.id,
      action: 'purge',
      reason: `Purged ${idsToDelete.length} message(s)${targetUsername ? ` from @${targetUsername.replace(/^@/, '')}` : ''} in #${channelId}`,
      durationSeconds: null,
    });

    return new Response(
      JSON.stringify({
        ok: true,
        deletedCount: idsToDelete.length,
        deletedIds: idsToDelete,
        channelId,
        message: targetUsername
          ? `✓ Purged ${idsToDelete.length} message(s) from @${targetUsername.replace(/^@/, '')} in #${channelId}.`
          : `✓ Purged ${idsToDelete.length} message(s) in #${channelId}.`,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    console.error('[chat:purge] Error:', err);
    return new Response(JSON.stringify({ ok: false, error: err?.message || 'Purge failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
