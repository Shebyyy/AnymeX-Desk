import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { db } from '../../../lib/db/client';
import { chatMessages, chatChannels, users, reports, chatMessageReactions } from '../../../lib/db/schema';
import { currentUser } from '../../../lib/auth';
import { levelOf, atLeast, isOwner } from '../../../lib/staff';
import { sendPushToUser, sendPushToAll, sendPushToStaff } from '../../../lib/webpush';
import { inIds } from '../../../lib/db/sql';
import { eq, desc, and, lt, sql } from 'drizzle-orm';
import { DEFAULT_CHANNELS } from './channels';

export const prerender = false;

export const GET: APIRoute = async (ctx) => {
  const url = new URL(ctx.request.url);
  const channelId = url.searchParams.get('channel') || 'general';
  const beforeId = url.searchParams.get('before') ? Number(url.searchParams.get('before')) : null;
  const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 100);

  try {
    const user = await currentUser(ctx);
    const isStaff = user ? atLeast(await levelOf(user.id), 'mod') : false;

    // Check channel existence and permissions
    let [channel] = await db()
      .select()
      .from(chatChannels)
      .where(eq(chatChannels.id, channelId))
      .limit(1);

    if (!channel) {
      const defaultMatch = DEFAULT_CHANNELS.find((c) => c.id === channelId);
      if (defaultMatch) {
        try {
          await db().insert(chatChannels).values(defaultMatch).onConflictDoNothing();
          [channel] = await db()
            .select()
            .from(chatChannels)
            .where(eq(chatChannels.id, channelId))
            .limit(1);
        } catch (e) {
          channel = defaultMatch as any;
        }
      }
    }

    if (!channel) {
      return new Response(JSON.stringify({ ok: false, error: 'Channel not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (channel.isStaffOnly && !isStaff) {
      return new Response(JSON.stringify({ ok: false, error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const whereClause = beforeId
      ? and(eq(chatMessages.channelId, channelId), lt(chatMessages.id, beforeId))
      : eq(chatMessages.channelId, channelId);

    const rawMessages = await db()
      .select({
        id: chatMessages.id,
        channelId: chatMessages.channelId,
        userId: chatMessages.userId,
        body: chatMessages.body,
        replyToId: chatMessages.replyToId,
        taggedReportIds: chatMessages.taggedReportIds,
        attachmentCount: chatMessages.attachmentCount,
        isPinned: chatMessages.isPinned,
        createdAt: chatMessages.createdAt,
        updatedAt: chatMessages.updatedAt,
        authorName: users.username,
        authorAvatar: users.avatarHash,
        discordLevel: users.discordLevel,
        manualLevel: users.manualLevel,
      })
      .from(chatMessages)
      .innerJoin(users, eq(users.discordId, chatMessages.userId))
      .where(whereClause)
      .orderBy(desc(chatMessages.createdAt))
      .limit(limit);

    // Messages in chronological order
    const ordered = rawMessages.reverse();
    const msgIds = ordered.map((m) => m.id);

    // Collect reply IDs to hydrate replies
    const replyIds = ordered
      .map((m) => m.replyToId)
      .filter((id): id is number => typeof id === 'number');

    const replyMap = new Map<number, { id: number; body: string; authorName: string; authorAvatar: string | null }>();
    if (replyIds.length > 0) {
      const parentMessages = await db()
        .select({
          id: chatMessages.id,
          body: chatMessages.body,
          authorName: users.username,
          authorAvatar: users.avatarHash,
        })
        .from(chatMessages)
        .innerJoin(users, eq(users.discordId, chatMessages.userId))
        .where(inIds(chatMessages.id, replyIds));

      for (const p of parentMessages) {
        replyMap.set(p.id, p);
      }
    }

    // Collect tagged report IDs to hydrate embeds
    const allReportIds = new Set<number>();
    for (const m of ordered) {
      if (m.taggedReportIds) {
        try {
          const ids: number[] = JSON.parse(m.taggedReportIds);
          for (const rid of ids) allReportIds.add(rid);
        } catch {}
      }
    }

    const reportMap = new Map<number, { id: number; title: string; status: string; kind: string; votes: number; category: string | null }>();
    if (allReportIds.size > 0) {
      const rList = await db()
        .select({
          id: reports.id,
          title: reports.title,
          status: reports.status,
          kind: reports.kind,
          votes: reports.votes,
          category: reports.category,
        })
        .from(reports)
        .where(inIds(reports.id, Array.from(allReportIds)));

      for (const r of rList) {
        reportMap.set(r.id, r);
      }
    }

    // Collect reactions for all messages
    const currentUserId = user?.id || '\0';
    const reactionsMap = new Map<number, Array<{ emoji: string; count: number; reactedByMe: boolean }>>();

    if (msgIds.length > 0) {
      const reactionRows = await db().all<{
        message_id: number;
        emoji: string;
        count: number;
        reacted_by_me: number;
      }>(sql`
        SELECT 
          message_id,
          emoji,
          count(*) as count,
          max(case when user_id = ${currentUserId} then 1 else 0 end) as reacted_by_me
        FROM chat_message_reactions
        WHERE ${inIds(chatMessageReactions.messageId, msgIds)}
        GROUP BY message_id, emoji
      `);

      for (const r of reactionRows) {
        const list = reactionsMap.get(r.message_id) || [];
        list.push({
          emoji: r.emoji,
          count: r.count,
          reactedByMe: r.reacted_by_me === 1,
        });
        reactionsMap.set(r.message_id, list);
      }
    }

    // Assemble enriched message objects
    const messages = ordered.map((m) => {
      let taggedReports: any[] = [];
      if (m.taggedReportIds) {
        try {
          const ids: number[] = JSON.parse(m.taggedReportIds);
          taggedReports = ids.map((id) => reportMap.get(id)).filter(Boolean);
        } catch {}
      }

      const role = isOwner(m.userId)
        ? 'owner'
        : m.manualLevel || m.discordLevel || 'member';

      return {
        id: m.id,
        channelId: m.channelId,
        userId: m.userId,
        body: m.body,
        replyToId: m.replyToId,
        attachmentCount: m.attachmentCount,
        isPinned: m.isPinned,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        isEdited: m.updatedAt > m.createdAt + 2,
        authorName: m.authorName,
        authorAvatar: m.authorAvatar,
        authorRole: role,
        replyTo: m.replyToId ? replyMap.get(m.replyToId) || null : null,
        taggedReports,
        reactions: reactionsMap.get(m.id) || [],
      };
    });

    return new Response(JSON.stringify({ ok: true, channel, messages }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[chat:messages:get] Error fetching chat messages:', err?.message || err);
    return new Response(JSON.stringify({ ok: false, error: err?.message || 'Internal Server Error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const POST: APIRoute = async (ctx) => {
  const user = await currentUser(ctx);
  if (!user) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const bodyJson = await ctx.request.json();
    const { channelId = 'general', body, replyToId } = bodyJson || {};

    if (!body || typeof body !== 'string' || !body.trim()) {
      return new Response(JSON.stringify({ ok: false, error: 'Message content cannot be empty' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const trimmedBody = body.trim().slice(0, 4000);
    const isStaff = atLeast(await levelOf(user.id), 'mod');

    // Enforce Chat Ban and Timeout
    const [authorRecord] = await db()
      .select({
        chatBanned: users.chatBanned,
        chatBanReason: users.chatBanReason,
        timedOutUntil: users.timedOutUntil,
        timeoutReason: users.timeoutReason,
      })
      .from(users)
      .where(eq(users.discordId, user.id))
      .limit(1);

    if (authorRecord?.chatBanned) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: `You are banned from chat. Reason: ${authorRecord.chatBanReason || 'No reason specified'}`,
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (authorRecord?.timedOutUntil && authorRecord.timedOutUntil > nowSec) {
      const remainingMinutes = Math.ceil((authorRecord.timedOutUntil - nowSec) / 60);
      return new Response(
        JSON.stringify({
          ok: false,
          error: `You are timed out for another ${remainingMinutes} min(s). Reason: ${authorRecord.timeoutReason || 'No reason specified'}`,
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      );
    }

    let [channel] = await db()
      .select()
      .from(chatChannels)
      .where(eq(chatChannels.id, channelId))
      .limit(1);

    if (!channel) {
      const defaultMatch = DEFAULT_CHANNELS.find((c) => c.id === channelId);
      if (defaultMatch) {
        try {
          await db().insert(chatChannels).values(defaultMatch).onConflictDoNothing();
          [channel] = await db()
            .select()
            .from(chatChannels)
            .where(eq(chatChannels.id, channelId))
            .limit(1);
        } catch (e) {
          channel = defaultMatch as any;
        }
      }
    }

    if (!channel) {
      return new Response(JSON.stringify({ ok: false, error: 'Channel does not exist' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (channel.isStaffOnly && !isStaff) {
      return new Response(JSON.stringify({ ok: false, error: 'Only staff can post in this channel' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Extract #123 report tags
    const reportMatches = Array.from(trimmedBody.matchAll(/#(\d+)\b/g));
    const taggedIds = Array.from(new Set(reportMatches.map((m) => parseInt(m[1], 10)))).slice(0, 5);
    const taggedReportIds = taggedIds.length > 0 ? JSON.stringify(taggedIds) : null;

    // Insert message into D1
    const [inserted] = await db()
      .insert(chatMessages)
      .values({
        channelId,
        userId: user.id,
        body: trimmedBody,
        replyToId: replyToId ? Number(replyToId) : null,
        taggedReportIds,
      })
      .returning();

    // ─────────────────────────────────────────────────────────────
    // Push Notifications for Replies & Mentions
    // ─────────────────────────────────────────────────────────────
    const cf = (ctx.locals as any)?.cfContext;
    const runtimeEnv = env as any;

    if (inserted.replyToId) {
      const [parent] = await db()
        .select({ userId: chatMessages.userId, body: chatMessages.body })
        .from(chatMessages)
        .where(eq(chatMessages.id, inserted.replyToId))
        .limit(1);

      if (parent && parent.userId !== user.id) {
        const task = sendPushToUser(
          parent.userId,
          {
            title: `#${channel.name}: ${user.username} replied to you`,
            body: trimmedBody.slice(0, 100),
            url: `/support?channel=${channelId}`,
            tag: `reply-${inserted.id}`,
          },
          runtimeEnv,
        );
        if (cf?.waitUntil) {
          cf.waitUntil(task);
        } else {
          task.catch(() => {});
        }
      }
    }

    const mentionMatches = Array.from(trimmedBody.matchAll(/@([a-zA-Z0-9_.-]+)/g));
    if (mentionMatches.length > 0) {
      const mentionedNames = Array.from(new Set(mentionMatches.map((m) => m[1].toLowerCase())));

      const hasEveryone = mentionedNames.includes('everyone') || mentionedNames.includes('here');
      const hasStaff = mentionedNames.includes('staff');
      const hasAdmin = mentionedNames.includes('admin');
      const hasMod = mentionedNames.includes('mod');

      if (hasEveryone) {
        const task = sendPushToAll(
          {
            title: `#${channel.name}: ${user.username} mentioned @everyone`,
            body: trimmedBody.slice(0, 120),
            url: `/support?channel=${channelId}`,
            tag: `mention-everyone-${inserted.id}`,
          },
          user.id,
          runtimeEnv,
        );
        if (cf?.waitUntil) cf.waitUntil(task);
        else task.catch(() => {});
      }

      if (hasStaff || hasAdmin || hasMod) {
        const roleLabel = hasAdmin ? '@admin' : hasMod ? '@mod' : '@staff';
        const task = sendPushToStaff(
          {
            title: `#${channel.name}: ${user.username} mentioned ${roleLabel}`,
            body: trimmedBody.slice(0, 120),
            url: `/support?channel=${channelId}`,
            tag: `mention-role-${inserted.id}`,
          },
          user.id,
          runtimeEnv,
        );
        if (cf?.waitUntil) cf.waitUntil(task);
        else task.catch(() => {});
      }

      // Filter out role and broadcast keywords for direct user mentions
      const specialKeywords = new Set(['everyone', 'here', 'staff', 'admin', 'mod']);
      const directUsers = mentionedNames.filter((n) => !specialKeywords.has(n));

      for (const name of directUsers) {
        const [targetUser] = await db()
          .select({ discordId: users.discordId })
          .from(users)
          .where(sql`lower(${users.username}) = lower(${name})`)
          .limit(1);

        if (targetUser && targetUser.discordId !== user.id) {
          const task = sendPushToUser(
            targetUser.discordId,
            {
              title: `#${channel.name}: ${user.username} mentioned you`,
              body: trimmedBody.slice(0, 100),
              url: `/support?channel=${channelId}`,
              tag: `mention-${inserted.id}`,
            },
            runtimeEnv,
          );
          if (cf?.waitUntil) {
            cf.waitUntil(task);
          } else {
            task.catch(() => {});
          }
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, message: inserted }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[chat:messages:post] Error creating chat message:', err?.message || err);
    return new Response(JSON.stringify({ ok: false, error: err?.message || 'Internal Server Error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const PATCH: APIRoute = async (ctx) => {
  const user = await currentUser(ctx);
  if (!user) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const { id, body } = await ctx.request.json();
    if (!id || !body || !body.trim()) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing message ID or content' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const messageId = Number(id);
    const [msg] = await db()
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId))
      .limit(1);

    if (!msg) {
      return new Response(JSON.stringify({ ok: false, error: 'Message not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const isStaff = atLeast(await levelOf(user.id), 'mod');
    if (msg.userId !== user.id && !isStaff) {
      return new Response(JSON.stringify({ ok: false, error: 'You cannot edit this message' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const trimmedBody = body.trim().slice(0, 4000);
    const reportMatches = Array.from(trimmedBody.matchAll(/#(\d+)\b/g));
    const taggedIds = Array.from(new Set(reportMatches.map((m) => parseInt(m[1], 10)))).slice(0, 5);
    const taggedReportIds = taggedIds.length > 0 ? JSON.stringify(taggedIds) : null;

    const [updated] = await db()
      .update(chatMessages)
      .set({
        body: trimmedBody,
        taggedReportIds,
        updatedAt: sql`(unixepoch())`,
      })
      .where(eq(chatMessages.id, messageId))
      .returning();

    return new Response(JSON.stringify({ ok: true, message: updated }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[chat:messages:patch] Edit error:', err);
    return new Response(JSON.stringify({ ok: false, error: 'Failed to edit message' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const DELETE: APIRoute = async (ctx) => {
  const user = await currentUser(ctx);
  if (!user) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const url = new URL(ctx.request.url);
    const id = url.searchParams.get('id');
    if (!id) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing message ID' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const messageId = Number(id);
    const [msg] = await db()
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId))
      .limit(1);

    if (!msg) {
      return new Response(JSON.stringify({ ok: false, error: 'Message not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const isStaff = atLeast(await levelOf(user.id), 'mod');
    if (msg.userId !== user.id && !isStaff) {
      return new Response(JSON.stringify({ ok: false, error: 'You cannot delete this message' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    await db()
      .delete(chatMessages)
      .where(eq(chatMessages.id, messageId));

    return new Response(JSON.stringify({ ok: true, id: messageId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[chat:messages:delete] Delete error:', err);
    return new Response(JSON.stringify({ ok: false, error: 'Failed to delete message' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
