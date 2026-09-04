import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { db } from '../../../lib/db/client';
import { users, reports, comments } from '../../../lib/db/schema';
import { eq, desc } from 'drizzle-orm';
import { resolveDiscordAvatarUrl, getOrCreateChannelWebhook } from '../../../lib/discord-forums';
import { readConfig } from '../../../lib/settings';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * TEMPORARY diagnostic. Calls the actual Discord webhook for the most recent
 * comment on a report, then immediately fetches the message back via the bot
 * API to see what avatar Discord ACTUALLY rendered. Returns the full truth.
 * Guarded by DISCORD_SYNC_SECRET.
 */
export const GET: APIRoute = async (ctx) => {
  const k = ctx.url.searchParams.get('k') ?? '';
  const expected = String(env.DISCORD_SYNC_SECRET ?? '').trim();
  if (!expected || k !== expected) return json({ error: 'forbidden' }, 403);

  const reportId = Number(ctx.url.searchParams.get('reportId'));
  if (!reportId) return json({ error: 'reportId required' }, 400);

  const cfg = await readConfig();
  const botToken = cfg.discord_bot_token;
  if (!botToken) return json({ error: 'no bot token configured' }, 500);

  // Get the report's discord thread
  const [report] = await db().select().from(reports).where(eq(reports.id, reportId));
  if (!report?.discordThreadId) return json({ error: 'report has no discord thread' }, 404);

  // Get the most recent comment + its author
  const [lastComment] = await db()
    .select()
    .from(comments)
    .where(eq(comments.reportId, reportId))
    .orderBy(desc(comments.id))
    .limit(1);
  if (!lastComment) return json({ error: 'no comments' }, 404 });

  const [author] = await db().select().from(users).where(eq(users.discordId, lastComment.userId));

  const avatarUrl = resolveDiscordAvatarUrl(author as any, 256);
  const username = author?.username?.slice(0, 80) ?? 'unknown';

  // Get the forum channel webhook
  let threadInfo: any = null;
  let hook: any = null;
  try {
    const tRes = await fetch(`https://discord.com/api/v10/channels/${report.discordThreadId}`, {
      headers: { Authorization: `Bot ${botToken}` },
    });
    threadInfo = tRes.ok ? await tRes.json() : { error: tRes.status, body: await tRes.text() };
    if (threadInfo?.parent_id) {
      hook = await getOrCreateChannelWebhook(threadInfo.parent_id, botToken);
    }
  } catch (e: any) {
    threadInfo = { error: String(e) };
  }

  // Execute the webhook with the avatar_url and capture Discord's response
  let execResult: any = null;
  let sentMessageId: string | null = null;
  if (hook) {
    try {
      const execRes = await fetch(
        `https://discord.com/api/v10/webhooks/${hook.id}/${hook.token}?thread_id=${report.discordThreadId}&wait=true`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            username,
            avatar_url: avatarUrl,
            content: `[avatar-debug] testing avatar_url for ${username}`,
          }),
        },
      );
      const execBody = await execRes.text();
      try { execResult = JSON.parse(execBody); sentMessageId = execResult?.id; } catch { execResult = { raw: execBody, status: execRes.status }; }
      execResult = { status: execRes.status, body: execResult };
    } catch (e: any) {
      execResult = { error: String(e) };
    }
  }

  // Now fetch the message back via the bot API to see what avatar it ACTUALLY rendered
  let fetchedMessage: any = null;
  if (sentMessageId) {
    try {
      const mRes = await fetch(
        `https://discord.com/api/v10/channels/${report.discordThreadId}/messages/${sentMessageId}`,
        { headers: { Authorization: `Bot ${botToken}` } },
      );
      fetchedMessage = mRes.ok ? await mRes.json() : { error: mRes.status, body: await mRes.text() };
    } catch (e: any) {
      fetchedMessage = { error: String(e) };
    }
  }

  return json({
    report: { id: report.id, discordThreadId: report.discordThreadId, kind: report.kind },
    author: { id: author?.discordId, username: author?.username, avatarHash: author?.avatarHash, discordUserId: author?.discordUserId },
    webhookAvatarUrl: avatarUrl,
    webhookUsername: username,
    threadInfo: { parent_id: threadInfo?.parent_id, name: threadInfo?.name, type: threadInfo?.type },
    webhook: hook ? { id: hook.id, hasToken: !!hook.token } : null,
    execResult,
    sentMessage: {
      id: fetchedMessage?.id,
      authorUsername: fetchedMessage?.author?.username,
      authorAvatarHash: fetchedMessage?.author?.avatar,
      authorAvatarUrl: fetchedMessage?.author?.avatar
        ? `https://cdn.discordapp.com/avatars/${fetchedMessage.author.id}/${fetchedMessage.author.avatar}.png`
        : 'NONE (default avatar)',
      webhookId: fetchedMessage?.webhook_id,
      isWebhookMessage: !!fetchedMessage?.webhook_id,
    },
  });
};
