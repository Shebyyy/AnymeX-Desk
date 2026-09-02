import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from './db/client';
import { reports, type Report, CATEGORY_LABELS, PLATFORM_LABELS, KIND_LABELS } from './db/schema';
import { readConfig, type Config } from './settings';
import { kindLabel, categoryLabel, platformLabel } from './format';
import { reporterName } from './reporter';
import { dbUser } from './auth';

/**
 * Outbound Discord announcements for the AnymeX tracker.
 *
 * A channel webhook needs only Manage Webhooks on one channel, so a maintainer
 * can hand over a URL without a bot and without giving this app any standing
 * permission.
 */

const GREEN = 0x3ba55d;
const YELLOW = 0xf5c542;
const RED = 0xed4245;

export interface Embed {
  title: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
}

export async function send(webhookUrl: string, embed: Embed) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ embeds: [{ color: YELLOW, ...embed }], allowed_mentions: { parse: [] } }),
  });
  return { ok: res.ok, status: res.status, body: res.ok ? '' : await res.text() };
}

/**
 * Announce a fix. Fires once per report; `announcedAt` is the guard.
 */
export async function announceFixed(report: Report, origin: string, cfg?: Config) {
  const c = cfg ?? (await readConfig());
  if (!c.webhook_url || c.webhook_on_fixed !== '1') return null;

  const claimed = await db()
    .update(reports)
    .set({ announcedAt: sql`(unixepoch())` })
    .where(and(eq(reports.id, report.id), isNull(reports.announcedAt)))
    .returning({ id: reports.id });
  if (!claimed.length) return null;

  const kindWord = report.kind === 'suggestion' ? 'Implemented' : 'Fixed';
  const fields = [{ name: 'Votes', value: `${report.votes} people`, inline: true }];
  if (report.category) fields.push({ name: 'Category', value: categoryLabel(report.category), inline: true });

  return send(c.webhook_url, {
    title: `${kindWord}: ${report.title}`,
    description: report.body ?? undefined,
    url: `${origin}/report/${report.id}`,
    color: GREEN,
    fields,
  });
}

/**
 * Announce a report that has crossed the demand threshold.
 */
export async function announceDemand(reportId: number, origin: string) {
  const cfg = await readConfig();
  const threshold = Number(cfg.webhook_vote_threshold || 0);
  if (!cfg.webhook_url || threshold <= 0) return null;

  const [report] = await db().select().from(reports).where(eq(reports.id, reportId));
  if (!report || report.announcedAt || report.votes < threshold) return null;

  const claimed = await db()
    .update(reports)
    .set({ announcedAt: sql`(unixepoch())` })
    .where(and(eq(reports.id, reportId), isNull(reports.announcedAt)))
    .returning({ id: reports.id });
  if (!claimed.length) return null;

  const kindWord = report.kind === 'suggestion' ? 'want' : 'are hit by';
  const title = `${report.votes} people ${kindWord}: ${report.title}`;

  const fields: { name: string; value: string; inline?: boolean }[] = [];
  fields.push({ name: 'Type', value: kindLabel(report.kind), inline: true });
  if (report.category) fields.push({ name: 'Category', value: categoryLabel(report.category), inline: true });
  if (report.platform) fields.push({ name: 'Platform', value: platformLabel(report.platform), inline: true });

  return send(cfg.webhook_url, {
    title,
    description: report.body ?? undefined,
    url: `${origin}/report/${report.id}`,
    fields,
  });
}

/**
 * Announce a newly filed report.
 *
 * One function that picks its own gate from `report.kind`.
 */
export async function announceFiled(
  report: Pick<
    Report,
    'id' | 'kind' | 'title' | 'body' | 'category' | 'platform' | 'appVersion' | 'reporterId'
  >,
  origin: string,
  cfg?: Config,
) {
  const c = cfg ?? (await readConfig());
  if (!c.webhook_url || c.webhook_on_new_report !== '1') return null;

  const who = await reporterName(report.reporterId, dbUser);

  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: 'Filed by', value: who, inline: true },
  ];
  fields.push({ name: 'Type', value: kindLabel(report.kind), inline: true });
  if (report.category) fields.push({ name: 'Category', value: categoryLabel(report.category), inline: true });
  if (report.platform) fields.push({ name: 'Platform', value: platformLabel(report.platform), inline: true });
  if (report.appVersion) fields.push({ name: 'App version', value: report.appVersion, inline: true });

  const color = report.kind === 'bug' ? RED : YELLOW;

  return send(c.webhook_url, {
    title: report.title,
    description: report.body ?? undefined,
    url: `${origin}/report/${report.id}`,
    color,
    fields,
  });
}

export async function testWebhook(webhookUrl: string, origin: string, actor: string) {
  return send(webhookUrl, {
    title: 'Webhook connected',
    description:
      `Sent from the AnymeX tracker dashboard by ${actor}. Status change ` +
      `announcements, demand alerts, and activity logs (votes, comments, ` +
      `replies, reports, staff actions) will all arrive in this channel.`,
    url: origin,
  });
}
