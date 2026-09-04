import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { db } from './db/client';
import { settings } from './db/schema';

/**
 * Runtime configuration.
 *
 * Every key has an environment-backed default, so a fresh database is already
 * a working install and the dashboard is an override rather than a prerequisite.
 */

export const SETTING_KEYS = [
  'mod_role_ids',
  'admin_role_ids',
  'min_account_age_days',
  'webhook_url',
  'webhook_on_fixed',
  'webhook_on_new_report',
  'webhook_vote_threshold',
  'max_image_size',
  'max_video_size',
  'max_images_per_report',
  'discord_dm_enabled',
  'discord_bot_token',
  'contributor_guild_id',
  'discord_forum_bugs_id',
  'discord_forum_suggestions_id',
  'discord_forum_extensions_id',
  'discord_forum_sync_enabled',
  'discord_sync_secret',
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

const DEFAULTS: Record<SettingKey, () => string> = {
  mod_role_ids: () => String(env.MAINTAINER_ROLE_IDS ?? ''),
  admin_role_ids: () => '',
  min_account_age_days: () => String(env.MIN_ACCOUNT_AGE_DAYS ?? 30),
  webhook_url: () => String(env.DISCORD_WEBHOOK_URL ?? ''),
  webhook_on_fixed: () => '1',
  webhook_on_new_report: () => '1',
  webhook_vote_threshold: () => '0',
  max_image_size: () => '5242880',
  max_video_size: () => '52428800',
  max_images_per_report: () => '5',
  discord_dm_enabled: () => '1',
  discord_bot_token: () => String((env as Record<string, unknown>).DISCORD_BOT_TOKEN ?? ''),
  contributor_guild_id: () => String((env as Record<string, unknown>).CONTRIBUTOR_GUILD_ID ?? '1545003117018357850'),
  discord_forum_bugs_id: () => String((env as Record<string, unknown>).DISCORD_FORUM_BUGS_ID ?? '1545003724961751096'),
  discord_forum_suggestions_id: () => String((env as Record<string, unknown>).DISCORD_FORUM_SUGGESTIONS_ID ?? '1545003626823417906'),
  discord_forum_extensions_id: () => String((env as Record<string, unknown>).DISCORD_FORUM_EXTENSIONS_ID ?? '1545003859380805702'),
  discord_forum_sync_enabled: () => '1',
  discord_sync_secret: () => String((env as Record<string, unknown>).DISCORD_SYNC_SECRET ?? 'anymex_sync_8f4a9b2c6e1d3075e82f419c8a74e5bd'),
};

export type Config = Record<SettingKey, string>;

export async function readConfig(): Promise<Config> {
  const rows = await db().select().from(settings);
  const stored = new Map(rows.map((r) => [r.key, r.value ?? '']));
  const out = {} as Config;
  for (const key of SETTING_KEYS) {
    const v = stored.get(key);
    out[key] = v === undefined ? DEFAULTS[key]() : v;
  }
  return out;
}

export async function writeSettings(
  values: Partial<Record<SettingKey, string>>,
  actorId: string,
) {
  const d = db();
  for (const [key, value] of Object.entries(values) as [SettingKey, string][]) {
    await d
      .insert(settings)
      .values({ key, value, updatedBy: actorId })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedBy: actorId, updatedAt: sql`(unixepoch())` },
      });
  }
}

export async function readSetting(key: SettingKey): Promise<string> {
  const [row] = await db().select().from(settings).where(eq(settings.key, key));
  return row?.value ?? DEFAULTS[key]();
}

/** Comma-separated ids, tolerant of spaces and stray newlines when pasted. */
export const idList = (raw: string): string[] =>
  raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{5,}$/.test(s));
