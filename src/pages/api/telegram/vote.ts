import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { db } from '../../../lib/db/client';
import { reports } from '../../../lib/db/schema';
import { readConfig } from '../../../lib/settings';
import { ensureVote } from '../../../lib/vote';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function validateSecret(req: Request, secret: string): boolean {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.replace(/^Bearer\s+/i, '');
  return token === secret;
}

/**
 * POST /api/telegram/vote
 * Upvote a report on behalf of a Telegram user
 */
export const POST: APIRoute = async (ctx) => {
  const cfg = await readConfig();
  if (cfg.discord_sync_secret) {
    if (!validateSecret(ctx.request, cfg.discord_sync_secret)) {
      return json({ error: 'unauthorized' }, 401);
    }
  }

  let body: Record<string, any>;
  try {
    body = await ctx.request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const { reportId, user } = body;
  if (!reportId || !user?.id) {
    return json({ error: 'missing reportId or user' }, 400);
  }

  const userDiscordId = `tg_${user.id}`;
  await ensureVote(Number(reportId), userDiscordId);

  const [row] = await db()
    .select({ votes: reports.votes })
    .from(reports)
    .where(eq(reports.id, Number(reportId)));

  return json({ ok: true, votes: row?.votes ?? 0 });
};
