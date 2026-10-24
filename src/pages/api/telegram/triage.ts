import { notifyReport } from '../../../lib/chat-hub';
import type { APIRoute } from 'astro';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../../lib/db/client';
import { reports, STATUSES, type Status } from '../../../lib/db/schema';
import { readConfig } from '../../../lib/settings';
import { logAction } from '../../../lib/staff';

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
 * POST /api/telegram/triage
 * Updates report status from Telegram staff action buttons
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

  const { reportId, status, staff } = body;
  if (!reportId || !status || !(STATUSES as readonly string[]).includes(status)) {
    return json({ error: 'invalid reportId or status' }, 400);
  }

  const d = db();
  const [report] = await d.select().from(reports).where(eq(reports.id, Number(reportId)));
  if (!report) {
    return json({ error: 'report not found' }, 404);
  }

  await d
    .update(reports)
    .set({
      status: status as Status,
      updatedAt: sql`(unixepoch())`,
    })
    .where(eq(reports.id, Number(reportId)));
  await notifyReport(Number(reportId));

  logAction(
    {
      id: staff?.id ? `tg_${staff.id}` : 'tg_staff',
      name: staff?.username || staff?.first_name || 'Telegram Staff',
      level: 'mod',
    },
    'report.status',
    `report #${reportId}`,
    `${report.status} → ${status}`,
    `${ctx.url.origin}/report/${reportId}`,
  );

  return json({ ok: true, status });
};
