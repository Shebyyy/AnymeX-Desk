import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { db } from '../../../lib/db/client';
import {
  reports,
  users,
  subscriptions,
  normalizeTitle,
  KINDS,
  PLATFORMS,
  STATUS_LABELS,
  CATEGORY_LABELS,
  PLATFORM_LABELS,
  KIND_LABELS,
} from '../../../lib/db/schema';
import { readConfig } from '../../../lib/settings';
import { findDuplicate } from '../../../lib/writes';
import { ensureVote } from '../../../lib/vote';
import { announceFiled } from '../../../lib/webhook';
import { createForumThread } from '../../../lib/discord-forums';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
    },
  });
}

function validateSecret(req: Request, secret: string): boolean {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.replace(/^Bearer\s+/i, '');
  return token === secret;
}

/**
 * GET /api/telegram/report?id=123
 */
export const GET: APIRoute = async (ctx) => {
  const id = Number(ctx.url.searchParams.get('id'));
  if (!id || isNaN(id)) {
    return json({ error: 'invalid id' }, 400);
  }

  const [report] = await db()
    .select()
    .from(reports)
    .where(eq(reports.id, id));

  if (!report) {
    return json({ error: 'not found' }, 404);
  }

  return json({
    ...report,
    kindLabel: KIND_LABELS[report.kind] ?? report.kind,
    categoryLabel: CATEGORY_LABELS[report.category] ?? report.category,
    platformLabel: PLATFORM_LABELS[report.platform] ?? report.platform,
    statusLabel: STATUS_LABELS[report.status] ?? report.status,
  });
};

/**
 * POST /api/telegram/report
 * Create a new report or auto-join duplicate from Telegram bot
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

  const {
    kind,
    category,
    platform,
    releaseChannel = 'stable',
    appVersion,
    pluginVersion,
    title,
    body: reportDesc,
    stepsToReproduce,
    testedNativeApp = false,
    extensionNames,
    extensionRepo,
    telegramUser,
  } = body;

  if (!kind || !category || !platform || !title) {
    return json({ error: 'missing required fields' }, 400);
  }

  const d = db();
  const tgId = telegramUser?.id ? String(telegramUser.id) : null;
  const userDiscordId = tgId ? `tg_${tgId}` : 'tg_anonymous';
  const username = telegramUser?.username || telegramUser?.first_name || 'Telegram User';

  // Upsert user
  await d
    .insert(users)
    .values({
      discordId: userDiscordId,
      username,
      telegramId: tgId,
      telegramUsername: telegramUser?.username || null,
      accountCreatedAt: Math.floor(Date.now() / 1000),
      firstSeen: Math.floor(Date.now() / 1000),
      lastLogin: Math.floor(Date.now() / 1000),
      lastSeen: Math.floor(Date.now() / 1000),
    })
    .onConflictDoUpdate({
      target: users.discordId,
      set: {
        username,
        telegramId: tgId,
        telegramUsername: telegramUser?.username || null,
        lastSeen: Math.floor(Date.now() / 1000),
      },
    });

  // Check deduplication
  const dup = await findDuplicate(kind, category, platform, title);
  if (dup) {
    if (!dup.locked) {
      await ensureVote(dup.id, userDiscordId);
    }
    return json({
      ok: true,
      duplicate: true,
      reportId: dup.id,
      url: `${ctx.url.origin}/report/${dup.id}`,
    });
  }

  // Insert new report
  const normalized = normalizeTitle(title);
  const [created] = await d
    .insert(reports)
    .values({
      kind,
      category,
      platform,
      releaseChannel: releaseChannel === 'beta' ? 'beta' : 'stable',
      appVersion: appVersion ? String(appVersion).slice(0, 32) : null,
      pluginVersion: pluginVersion ? String(pluginVersion).slice(0, 32) : null,
      title: String(title).slice(0, 200),
      titleNormalized: normalized,
      body: reportDesc ? String(reportDesc).slice(0, 5000) : null,
      stepsToReproduce: stepsToReproduce ? String(stepsToReproduce).slice(0, 5000) : null,
      testedNativeApp: Boolean(testedNativeApp),
      extensionNames: extensionNames ? String(extensionNames) : null,
      extensionRepo: extensionRepo ? String(extensionRepo).slice(0, 2000) : null,
      reporterId: userDiscordId,
      status: 'open',
    })
    .returning();

  if (!created) {
    return json({ error: 'failed to create report' }, 500);
  }

  // Auto-subscribe reporter
  await d.insert(subscriptions).values({
    reportId: created.id,
    userId: userDiscordId,
  }).catch(() => {});

  // Upvote own report
  await ensureVote(created.id, userDiscordId).catch(() => {});

  // Webhook announcement and Discord forum thread sync (background)
  ctx.locals.cfContext?.waitUntil(
    Promise.allSettled([
      announceFiled(created, ctx.url.origin),
      createForumThread(created, ctx.url.origin, {
        name: username,
      }),
    ]),
  );

  return json({
    ok: true,
    duplicate: false,
    reportId: created.id,
    url: `${ctx.url.origin}/report/${created.id}`,
  });
};
