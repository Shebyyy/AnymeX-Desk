import { and, asc, eq, isNull, isNotNull, sql } from 'drizzle-orm';
import { db } from './db/client';
import {
  reports,
  comments,
  attachments,
  users,
  type Report,
  type Comment,
  type User,
  STATUS_LABELS,
  PLATFORM_LABELS,
  CATEGORY_LABELS,
  KIND_LABELS,
  type Status,
} from './db/schema';
import { readConfig, type Config } from './settings';
import { avatarUrl } from './auth';
import { reporterName } from './reporter';
import { dbUser } from './auth';
import { statusLabel, categoryLabel, platformLabel, kindLabel } from './format';
import { GREEN, YELLOW, RED, BLURPLE, statusColor } from './webhook';

const DISCORD_API = 'https://discord.com/api/v10';

interface DiscordTag {
  id?: string;
  name: string;
  moderated?: boolean;
  emoji_id?: string | null;
  emoji_name?: string | null;
}

interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  available_tags?: DiscordTag[];
  applied_tags?: string[];
}

/** Standard status tags to populate on Bug channels */
export const BUG_STATUS_TAGS_DEF: DiscordTag[] = [
  { name: 'Open', moderated: false, emoji_name: '🟢' },
  { name: 'In Progress', moderated: true, emoji_name: '🟡' },
  { name: 'Fixed', moderated: true, emoji_name: '✅' },
  { name: 'Duplicate', moderated: true, emoji_name: '🔄' },
  { name: "Won't Fix", moderated: true, emoji_name: '❌' },
];

/** Standard status tags to populate on Suggestion channels */
export const SUGGESTION_STATUS_TAGS_DEF: DiscordTag[] = [
  { name: 'Open', moderated: false, emoji_name: '💡' },
  { name: 'Under Review', moderated: true, emoji_name: '🔍' },
  { name: 'Planned', moderated: true, emoji_name: '💡' },
  { name: 'In Progress', moderated: true, emoji_name: '🟡' },
  { name: 'Completed', moderated: true, emoji_name: '✅' },
  { name: 'Declined', moderated: true, emoji_name: '❌' },
  { name: 'Duplicate', moderated: true, emoji_name: '🔄' },
];

/** Backward-compat alias */
export const STATUS_TAGS_DEF = BUG_STATUS_TAGS_DEF;

/** Standard platform tags for Bug forum */
export const PLATFORM_TAGS_DEF: DiscordTag[] = [
  { name: 'Android', moderated: false },
  { name: 'iOS', moderated: false },
  { name: 'Windows', moderated: false },
  { name: 'macOS', moderated: false },
  { name: 'Linux', moderated: false },
  { name: 'All Platforms', moderated: false },
];

/** Standard category tags for Suggestion forum */
export const SUGGESTION_CATEGORY_TAGS_DEF: DiscordTag[] = [
  { name: 'Player', moderated: false },
  { name: 'UI / UX', moderated: false },
  { name: 'Library', moderated: false },
  { name: 'Tracking', moderated: false },
  { name: 'Extensions', moderated: false },
  { name: 'Manga Reader', moderated: false },
  { name: 'Novel Reader', moderated: false },
  { name: 'Download', moderated: false },
  { name: 'Other', moderated: false },
];

/** Standard source tags for Extension Issue forums */
export const EXTENSION_SOURCE_TAGS_DEF: DiscordTag[] = [
  { name: 'Mihon / Aniyomi', moderated: false },
  { name: 'Mangayomi', moderated: false },
  { name: 'Sora', moderated: false },
  { name: 'LNReader', moderated: false },
  { name: 'Cloudstream', moderated: false },
  { name: 'Kotatsu', moderated: false },
  { name: 'Other Source', moderated: false },
];

/** Tag cache to avoid fetching Discord tags on every single request */
const tagCache = new Map<string, { fetchedAt: number; tags: Map<string, string> }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Get forum channel ID for a report kind
 */
export function getForumChannelId(kind: Report['kind'], cfg: Config): string | null {
  if (kind === 'bug') return cfg.discord_forum_bugs_id || null;
  if (kind === 'suggestion') return cfg.discord_forum_suggestions_id || null;
  if (kind === 'extension') return cfg.discord_forum_extensions_id || null;
  return null;
}

/**
 * Fetch or auto-create required tags on a Discord forum channel.
 * Returns a map of lowercased tag name -> tag ID snowflake.
 */
export async function ensureForumTags(
  channelId: string,
  botToken: string,
  kind: Report['kind'],
): Promise<Map<string, string>> {
  const cached = tagCache.get(channelId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.tags;
  }

  const res = await fetch(`${DISCORD_API}/channels/${channelId}`, {
    headers: { Authorization: `Bot ${botToken}` },
  });

  if (!res.ok) {
    console.error(`[ForumSync] Failed to fetch channel ${channelId}:`, res.status, await res.text());
    return new Map();
  }

  const channel = (await res.json()) as DiscordChannel;
  const existingTags = channel.available_tags || [];
  const tagMap = new Map<string, string>();

  for (const t of existingTags) {
    if (t.id) tagMap.set(t.name.toLowerCase(), t.id);
  }

  // Determine what tags should exist
  const desiredTags: DiscordTag[] = [];
  if (kind === 'suggestion') {
    desiredTags.push(...SUGGESTION_STATUS_TAGS_DEF, ...SUGGESTION_CATEGORY_TAGS_DEF);
  } else if (kind === 'extension') {
    desiredTags.push(...BUG_STATUS_TAGS_DEF, ...EXTENSION_SOURCE_TAGS_DEF);
  } else {
    desiredTags.push(...BUG_STATUS_TAGS_DEF, ...PLATFORM_TAGS_DEF);
  }

  // Find tags that need to be created (limit 20 tags per channel per Discord rules)
  const tagsToKeep = [...existingTags];
  let changed = false;

  for (const desired of desiredTags) {
    if (!tagMap.has(desired.name.toLowerCase())) {
      if (tagsToKeep.length < 20) {
        tagsToKeep.push(desired);
        changed = true;
      }
    }
  }

  if (changed) {
    const patchRes = await fetch(`${DISCORD_API}/channels/${channelId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ available_tags: tagsToKeep }),
    });

    if (patchRes.ok) {
      const updatedChannel = (await patchRes.json()) as DiscordChannel;
      tagMap.clear();
      for (const t of updatedChannel.available_tags || []) {
        if (t.id) tagMap.set(t.name.toLowerCase(), t.id);
      }
      console.log(`[ForumSync] Auto-created tags on forum ${channelId}`);
    } else {
      console.warn(`[ForumSync] Could not update tags on forum ${channelId}:`, await patchRes.text());
    }
  }

  tagCache.set(channelId, { fetchedAt: Date.now(), tags: tagMap });
  return tagMap;
}

/**
 * Maps report status to tag name based on report kind
 */
export function statusToTagName(status: Status, kind: Report['kind'] = 'bug'): string {
  if (kind === 'suggestion') {
    switch (status) {
      case 'open':
        return 'open';
      case 'under_review':
        return 'under review';
      case 'confirmed':
        return 'planned';
      case 'in_progress':
        return 'in progress';
      case 'fixed':
        return 'completed';
      case 'duplicate':
        return 'duplicate';
      case 'wont_fix':
        return 'declined';
      default:
        return 'under review';
    }
  }
  switch (status) {
    case 'open':
    case 'confirmed':
      return 'open';
    case 'in_progress':
      return 'in progress';
    case 'fixed':
      return 'fixed';
    case 'duplicate':
      return 'duplicate';
    case 'wont_fix':
      return "won't fix";
    default:
      return 'open';
  }
}

/**
 * Maps suggestion category to tag name
 */
export function suggestionCategoryToTagName(cat: string): string {
  if (cat === 'ui_ux') return 'ui / ux';
  if (cat === 'manga_reader') return 'manga reader';
  if (cat === 'novel_reader') return 'novel reader';
  return cat.toLowerCase();
}

/**
 * Maps report platform to tag name
 */
export function platformToTagName(platform: string): string {
  if (platform === 'all') return 'all platforms';
  if (platform === 'ios') return 'ios';
  if (platform === 'macos') return 'macos';
  return platform.toLowerCase();
}

/**
 * Maps extension source to tag name
 */
export function extensionSourceToTagName(source: string): string {
  switch (source) {
    case 'mihon_aniyomi':
      return 'mihon / aniyomi';
    case 'mangayomi':
      return 'mangayomi';
    case 'sora':
      return 'sora';
    case 'lnreader':
      return 'lnreader';
    case 'cloudstream':
      return 'cloudstream';
    case 'kotatsu':
      return 'kotatsu';
    default:
      return 'other source';
  }
}

/**
 * Formats starter embed for a report forum thread
 */
export async function buildReportEmbed(report: Report, origin: string) {
  const who = await reporterName(report.reporterId, dbUser);
  const isSuggestion = report.kind === 'suggestion';
  const color =
    report.kind === 'bug' ? RED : isSuggestion ? YELLOW : BLURPLE;

  const displayStatus = isSuggestion
    ? report.status === 'fixed'
      ? 'Completed'
      : report.status === 'open' ? 'Open' : report.status === 'under_review' ? 'Under Review'
        : report.status === 'confirmed'
          ? 'Planned'
          : report.status === 'wont_fix'
            ? 'Declined'
            : statusLabel(report.status)
    : statusLabel(report.status);

  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: isSuggestion ? 'Suggested By' : 'Filed By', value: who, inline: true },
    { name: 'Type', value: kindLabel(report.kind), inline: true },
    { name: 'Status', value: displayStatus, inline: true },
  ];

  if (report.category) {
    fields.push({ name: 'Category', value: categoryLabel(report.category), inline: true });
  }
  if (!isSuggestion && report.platform) {
    fields.push({ name: 'Platform', value: platformLabel(report.platform), inline: true });
  }
  if (!isSuggestion && report.appVersion) {
    fields.push({ name: 'App Version', value: report.appVersion, inline: true });
  }

  if (report.kind === 'extension') {
    if (report.extensionNames) {
      fields.push({ name: 'Extension Name(s)', value: report.extensionNames, inline: false });
    }
    if (report.extensionRepo) {
      fields.push({ name: 'Extension Repository', value: report.extensionRepo, inline: false });
    }
    if (report.testedNativeApp !== null) {
      fields.push({
        name: 'Works in Native App?',
        value: report.testedNativeApp ? '✅ Yes (Fails only in AnymeX)' : '❌ No',
        inline: true,
      });
    }
  }

  if (report.kind === 'bug' && report.stepsToReproduce) {
    const steps = report.stepsToReproduce.slice(0, 1024);
    fields.push({ name: 'Steps to Reproduce', value: steps, inline: false });
  }

  // Fetch report-level attachments (screenshots / recordings)
  const d = db();
  const reportAtts = await d
    .select()
    .from(attachments)
    .where(and(eq(attachments.reportId, report.id), isNull(attachments.commentId)));

  const firstImage = reportAtts.find((a) => a.fileType === 'image');
  const otherFiles = reportAtts.filter((a) => a.id !== firstImage?.id);

  if (otherFiles.length > 0) {
    fields.push({
      name: 'Attachments',
      value: otherFiles
        .slice(0, 5)
        .map(
          (f) =>
            `📎 [${f.fileName}](${f.filePath.startsWith('http') ? f.filePath : `${origin}/${f.filePath.replace(/^\/+/, '')}`})`,
        )
        .join('\n'),
      inline: false,
    });
  }

  const imageUrl = firstImage
    ? firstImage.filePath.startsWith('http')
      ? firstImage.filePath
      : `${origin}/${firstImage.filePath.replace(/^\/+/, '')}`
    : undefined;

  return {
    title: `[#${report.id}] ${report.title}`.slice(0, 256),
    description: report.body
      ? report.body.slice(0, 2000)
      : isSuggestion
        ? '_No suggestion details provided._'
        : '_No description provided._',
    url: `${origin}/report/${report.id}`,
    color,
    fields,
    image: imageUrl ? { url: imageUrl } : undefined,
    footer: { text: `AnymeX Tracker • ${isSuggestion ? 'Suggestion' : 'Report'} #${report.id}` },
    timestamp: new Date((report.createdAt || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
  };
}

/**
 * Create a new Forum Thread on the Contributor Discord Server
 */
export async function createForumThread(
  report: Report,
  origin: string,
  cfg?: Config,
): Promise<{ threadId: string; starterMessageId: string } | null> {
  const c = cfg ?? (await readConfig());
  if (c.discord_forum_sync_enabled !== '1') return null;

  const botToken = c.discord_bot_token;
  if (!botToken) {
    console.warn('[ForumSync] Skipped createForumThread: no discord_bot_token configured');
    return null;
  }

  const channelId = getForumChannelId(report.kind, c);
  if (!channelId) {
    console.warn(`[ForumSync] No forum channel configured for kind: ${report.kind}`);
    return null;
  }

  try {
    const tagsMap = await ensureForumTags(channelId, botToken, report.kind);
    const appliedTags: string[] = [];

    // Status tag
    const statusTagName = statusToTagName(report.status, report.kind);
    const statusTagId = tagsMap.get(statusTagName);
    if (statusTagId) appliedTags.push(statusTagId);

    // Platform, Category, or Source tag
    if (report.kind === 'extension') {
      const sourceTagName = extensionSourceToTagName(report.category);
      const sourceTagId = tagsMap.get(sourceTagName);
      if (sourceTagId) appliedTags.push(sourceTagId);
    } else if (report.kind === 'suggestion') {
      const catTagName = suggestionCategoryToTagName(report.category);
      const catTagId = tagsMap.get(catTagName);
      if (catTagId) appliedTags.push(catTagId);
    } else if (report.platform) {
      const platformTagName = platformToTagName(report.platform);
      const platformTagId = tagsMap.get(platformTagName);
      if (platformTagId) appliedTags.push(platformTagId);
    }

    const embed = await buildReportEmbed(report, origin);
    const threadName = `[#${report.id}] ${report.title}`.slice(0, 100);

    const payload = {
      name: threadName,
      applied_tags: appliedTags,
      message: {
        embeds: [embed],
        components: [
          {
            type: 1, // ActionRow
            components: [
              {
                type: 2, // Button
                style: 5, // Link
                label: 'View on AnymeX Desk',
                url: `${origin}/report/${report.id}`,
              },
            ],
          },
        ],
      },
    };

    const res = await fetch(`${DISCORD_API}/channels/${channelId}/threads`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.error('[ForumSync] Failed to create forum thread:', res.status, await res.text());
      return null;
    }

    const data = (await res.json()) as { id: string; message?: { id: string } };
    const threadId = data.id;
    const starterMessageId = data.message?.id || threadId;

    // Save thread and starter message ID to DB
    await db()
      .update(reports)
      .set({
        discordThreadId: threadId,
        discordStarterMessageId: starterMessageId,
      })
      .where(eq(reports.id, report.id));

    console.log(`[ForumSync] Created Discord Forum thread ${threadId} for report #${report.id}`);
    return { threadId, starterMessageId };
  } catch (err) {
    console.error('[ForumSync] Exception in createForumThread:', err);
    return null;
  }
}

/**
 * Update the Forum Thread title and starter message when a report is edited
 */
export async function updateForumThread(
  report: Report,
  origin: string,
  cfg?: Config,
): Promise<boolean> {
  const c = cfg ?? (await readConfig());
  if (c.discord_forum_sync_enabled !== '1') return false;

  const botToken = c.discord_bot_token;
  if (!botToken || !report.discordThreadId) return false;

  try {
    const threadName = `[#${report.id}] ${report.title}`.slice(0, 100);

    // Update thread name
    await fetch(`${DISCORD_API}/channels/${report.discordThreadId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: threadName }),
    });

    // Update starter message embed if recorded
    if (report.discordStarterMessageId) {
      const embed = await buildReportEmbed(report, origin);
      await fetch(
        `${DISCORD_API}/channels/${report.discordThreadId}/messages/${report.discordStarterMessageId}`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bot ${botToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ embeds: [embed] }),
        },
      );
    }

    return true;
  } catch (err) {
    console.error('[ForumSync] Exception in updateForumThread:', err);
    return false;
  }
}

/**
 * Update the Forum Thread tag and post a status notice when report status changes
 */
export async function updateForumStatus(
  report: Report,
  newStatus: Status,
  statusNote?: string | null,
  actorName?: string,
  cfg?: Config,
): Promise<boolean> {
  const c = cfg ?? (await readConfig());
  if (c.discord_forum_sync_enabled !== '1') return false;

  const botToken = c.discord_bot_token;
  if (!botToken || !report.discordThreadId) return false;

  const channelId = getForumChannelId(report.kind, c);
  if (!channelId) return false;

  try {
    const tagsMap = await ensureForumTags(channelId, botToken, report.kind);

    // Get current applied tags on the thread
    const threadRes = await fetch(`${DISCORD_API}/channels/${report.discordThreadId}`, {
      headers: { Authorization: `Bot ${botToken}` },
    });

    let currentTags: string[] = [];
    if (threadRes.ok) {
      const threadData = (await threadRes.json()) as DiscordChannel;
      currentTags = threadData.applied_tags || [];
    }

    // Filter out any existing status tags
    const statusDefList = report.kind === 'suggestion' ? SUGGESTION_STATUS_TAGS_DEF : BUG_STATUS_TAGS_DEF;
    const allStatusTagIds = new Set(
      statusDefList.map((t) => tagsMap.get(t.name.toLowerCase())).filter(Boolean) as string[],
    );
    const nonStatusTags = currentTags.filter((id) => !allStatusTagIds.has(id));

    // Add new status tag
    const newStatusTagName = statusToTagName(newStatus, report.kind);
    const newStatusTagId = tagsMap.get(newStatusTagName);
    if (newStatusTagId) nonStatusTags.push(newStatusTagId);

    const isClosed = newStatus === 'fixed' || newStatus === 'wont_fix' || newStatus === 'duplicate';

    // Update thread tags (and optionally archive if closed)
    await fetch(`${DISCORD_API}/channels/${report.discordThreadId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        applied_tags: nonStatusTags,
        archived: isClosed ? true : false,
      }),
    });

    const displayStatus = report.kind === 'suggestion'
      ? newStatus === 'fixed'
        ? 'Completed'
        : newStatus === 'open' ? 'Open' : newStatus === 'under_review' ? 'Under Review'
          : newStatus === 'confirmed'
            ? 'Planned'
            : newStatus === 'wont_fix'
              ? 'Declined'
              : statusLabel(newStatus)
      : statusLabel(newStatus);

    // Send status update message inside thread
    const noteLine = statusNote ? `\n> ${statusNote}` : '';
    const byLine = actorName ? ` by **${actorName}**` : '';
    await fetch(`${DISCORD_API}/channels/${report.discordThreadId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        embeds: [
          {
            title: `Status: ${displayStatus}`,
            description: `${report.kind === 'suggestion' ? 'Suggestion' : 'Report'} status was updated to **${displayStatus}**${byLine}.${noteLine}`,
            color: statusColor(newStatus),
          },
        ],
      }),
    });

    return true;
  } catch (err) {
    console.error('[ForumSync] Exception in updateForumStatus:', err);
    return false;
  }
}

/**
 * Delete or archive the Forum Thread when a report is deleted
 */
export async function deleteForumThread(
  threadId: string,
  reportTitle?: string,
  cfg?: Config,
): Promise<boolean> {
  const c = cfg ?? (await readConfig());
  const botToken = c.discord_bot_token;
  if (!botToken || !threadId) return false;

  try {
    // Post tombstone message first, then lock and archive
    await fetch(`${DISCORD_API}/channels/${threadId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        embeds: [
          {
            title: '⚠️ Report Deleted',
            description: `This report ${reportTitle ? `("${reportTitle}") ` : ''}was deleted on AnymeX Desk. This thread is now locked and archived.`,
            color: RED,
          },
        ],
      }),
    });

    // Lock and archive thread
    await fetch(`${DISCORD_API}/channels/${threadId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ locked: true, archived: true }),
    });

    return true;
  } catch (err) {
    console.error('[ForumSync] Exception in deleteForumThread:', err);
    return false;
  }
}

/** Webhook cache to avoid repeated webhook lookups per channel */
const webhookCache = new Map<string, { id: string; token: string }>();

/**
 * Get or create a webhook on the forum channel to send comments using user's avatar & name
 */
export async function getOrCreateChannelWebhook(
  channelId: string,
  botToken: string,
): Promise<{ id: string; token: string } | null> {
  const cached = webhookCache.get(channelId);
  if (cached) return cached;

  try {
    const listRes = await fetch(`${DISCORD_API}/channels/${channelId}/webhooks`, {
      headers: { Authorization: `Bot ${botToken}` },
    });

    if (listRes.ok) {
      const hooks = (await listRes.json()) as Array<{ id: string; token?: string; name: string }>;
      const existing = hooks.find((h) => h.token);
      if (existing && existing.token) {
        webhookCache.set(channelId, { id: existing.id, token: existing.token });
        return { id: existing.id, token: existing.token };
      }
    }

    // Create a new webhook for this channel
    const createRes = await fetch(`${DISCORD_API}/channels/${channelId}/webhooks`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'AnymeX Desk Bridge' }),
    });

    if (createRes.ok) {
      const created = (await createRes.json()) as { id: string; token: string };
      if (created.token) {
        webhookCache.set(channelId, { id: created.id, token: created.token });
        return { id: created.id, token: created.token };
      }
    }
  } catch (err) {
    console.warn('[ForumSync] Could not get or create webhook for channel', channelId, err);
  }

  return null;
}

/**
 * Resolves a valid Discord CDN avatar URL for either a session user or DB user row
 */
export function resolveDiscordAvatarUrl(
  author: { id?: string; discordId?: string; avatarHash?: string | null },
  size = 256,
): string {
  const snowflake = author.discordId || author.id;
  if (snowflake && author.avatarHash) {
    const ext = author.avatarHash.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${snowflake}/${author.avatarHash}.${ext}`;
  }
  if (snowflake) {
    try {
      const idx = (BigInt(snowflake) >> 22n) % 6n;
      return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
    } catch {
      return 'https://cdn.discordapp.com/embed/avatars/0.png';
    }
  }
  return 'https://cdn.discordapp.com/embed/avatars/0.png';
}

/**
 * Forward a site comment to the Discord Forum Thread
 */
export type MentionTarget = string | { id: string; username: string };

/**
 * Forward a site comment to the Discord Forum Thread
 */
export async function syncCommentToDiscord(
  report: Pick<Report, 'id' | 'discordThreadId' | 'kind'>,
  comment: Pick<Comment, 'id' | 'body' | 'replyToId'>,
  author: User,
  attachmentUrls?: string[],
  cfg?: Config,
  mentions?: MentionTarget[],
  attachmentFiles?: Array<{ name: string; buffer: ArrayBuffer; mimeType?: string }>,
): Promise<string | null> {
  const c = cfg ?? (await readConfig());
  if (c.discord_forum_sync_enabled !== '1') return null;

  const botToken = c.discord_bot_token;
  if (!botToken || !report.discordThreadId) return null;

  try {
    const avatar = resolveDiscordAvatarUrl(author as any, 256);

    let bodyText = comment.body || '';

    // Replace @username in-place with <@id> so Discord displays the ping naturally in the sentence
    // without repeating it as a separate ping prefix.
    const mentionedIds: string[] = [];
    if (mentions && mentions.length > 0) {
      for (const m of mentions) {
        if (typeof m === 'string') {
          mentionedIds.push(m);
        } else if (m && m.id) {
          mentionedIds.push(m.id);
          if (m.username) {
            const escaped = m.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`@${escaped}(?![a-zA-Z0-9_])`, 'gi');
            bodyText = bodyText.replace(re, `<@${m.id}>`);
          }
        }
      }
    }

    // Only prepend IDs that were not replaced in-place inside the body text
    const unplacedPings = mentionedIds.filter((id) => !bodyText.includes(`<@${id}>`));
    const mentionPrefix =
      unplacedPings.length > 0 ? unplacedPings.map((id) => `<@${id}>`).join(' ') + ' ' : '';

    // Unarchive thread if it was archived
    await fetch(`${DISCORD_API}/channels/${report.discordThreadId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ archived: false }),
    }).catch(() => {});

    // Resolve reply info if this is a reply to another comment
    let messageReference: { message_id: string; channel_id?: string } | undefined;
    let parentUserDiscordId: string | null = null;
    if (comment.replyToId != null) {
      const [parent] = await db()
        .select({ discordMessageId: comments.discordMessageId, userId: comments.userId })
        .from(comments)
        .where(eq(comments.id, comment.replyToId));

      if (parent?.discordMessageId) {
        messageReference = {
          message_id: parent.discordMessageId,
          channel_id: report.discordThreadId,
        };
      }
      if (parent?.userId) {
        parentUserDiscordId = parent.userId;
      }
    }

    let finalContent = (mentionPrefix + bodyText).trim();

    // If there is no messageReference (parent comment was site-only) and author wasn't already pinged, prepend ping
    if (
      !messageReference &&
      parentUserDiscordId &&
      !mentionedIds.includes(parentUserDiscordId) &&
      !bodyText.includes(parentUserDiscordId)
    ) {
      finalContent = `<@${parentUserDiscordId}> ${finalContent}`.trim();
    }

    // Append URL links for attachments if any
    const cleanUrls = (attachmentUrls || []).map((u) => u.trim()).filter(Boolean);
    if (cleanUrls.length > 0) {
      finalContent = (finalContent ? `${finalContent}\n` : '') + cleanUrls.join('\n');
    }

    const hasNativeFiles = attachmentFiles && attachmentFiles.length > 0;
    if (!finalContent && !hasNativeFiles) {
      finalContent = '(attachment)';
    }

    // Attempt to send via Webhook so message uses the user's Discord Avatar & Username
    let forumChannelId = report.kind ? getForumChannelId(report.kind, c) : null;
    if (!forumChannelId) {
      try {
        const tRes = await fetch(`${DISCORD_API}/channels/${report.discordThreadId}`, {
          headers: { Authorization: `Bot ${botToken}` },
        });
        if (tRes.ok) {
          const tData = (await tRes.json()) as { parent_id?: string };
          if (tData.parent_id) forumChannelId = tData.parent_id;
        }
      } catch {}
    }

    const hook = forumChannelId
      ? await getOrCreateChannelWebhook(forumChannelId, botToken)
      : null;

    let res: Response | null = null;
    if (hook) {
      if (hasNativeFiles) {
        const form = new FormData();
        form.append(
          'payload_json',
          JSON.stringify({
            username: author.username.slice(0, 80),
            avatar_url: avatar,
            content: finalContent.slice(0, 2000),
            message_reference: messageReference,
            allowed_mentions: {
              parse: ['users'],
              replied_user: true,
            },
          }),
        );
        for (let i = 0; i < attachmentFiles.length; i++) {
          const f = attachmentFiles[i];
          form.append(
            `files[${i}]`,
            new Blob([f.buffer], { type: f.mimeType || 'application/octet-stream' }),
            f.name,
          );
        }
        res = await fetch(
          `${DISCORD_API}/webhooks/${hook.id}/${hook.token}?thread_id=${report.discordThreadId}&wait=true`,
          {
            method: 'POST',
            body: form,
          },
        );
      } else {
        res = await fetch(
          `${DISCORD_API}/webhooks/${hook.id}/${hook.token}?thread_id=${report.discordThreadId}&wait=true`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: author.username.slice(0, 80),
              avatar_url: avatar,
              content: finalContent.slice(0, 2000),
              message_reference: messageReference,
              allowed_mentions: {
                parse: ['users'],
                replied_user: true,
              },
            }),
          },
        );
      }

      if (!res.ok) {
        console.warn(
          `[ForumSync] Webhook execution failed (${res.status}):`,
          await res.text(),
        );
        res = null; // fall through to bot path
      }
    }

    // Fallback: post as bot with username prefix in plain content
    if (!res || !res.ok) {
      const fallbackContent = `**${author.username}** (via Desk):\n${finalContent}`.slice(0, 2000);

      if (hasNativeFiles) {
        const form = new FormData();
        form.append(
          'payload_json',
          JSON.stringify({
            content: fallbackContent,
            message_reference: messageReference,
            allowed_mentions: { parse: ['users'], replied_user: true },
          }),
        );
        for (let i = 0; i < attachmentFiles.length; i++) {
          const f = attachmentFiles[i];
          form.append(
            `files[${i}]`,
            new Blob([f.buffer], { type: f.mimeType || 'application/octet-stream' }),
            f.name,
          );
        }
        res = await fetch(`${DISCORD_API}/channels/${report.discordThreadId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bot ${botToken}` },
          body: form,
        });
      } else {
        res = await fetch(`${DISCORD_API}/channels/${report.discordThreadId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bot ${botToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: fallbackContent,
            message_reference: messageReference,
            allowed_mentions: { parse: ['users'], replied_user: true },
          }),
        });
      }

      // If Discord rejected due to invalid message_reference, retry without it
      if (!res.ok && messageReference) {
        if (hasNativeFiles) {
          const form = new FormData();
          form.append(
            'payload_json',
            JSON.stringify({
              content: fallbackContent,
              allowed_mentions: { parse: ['users'], replied_user: true },
            }),
          );
          for (let i = 0; i < attachmentFiles.length; i++) {
            const f = attachmentFiles[i];
            form.append(
              `files[${i}]`,
              new Blob([f.buffer], { type: f.mimeType || 'application/octet-stream' }),
              f.name,
            );
          }
          res = await fetch(`${DISCORD_API}/channels/${report.discordThreadId}/messages`, {
            method: 'POST',
            headers: { Authorization: `Bot ${botToken}` },
            body: form,
          });
        } else {
          res = await fetch(`${DISCORD_API}/channels/${report.discordThreadId}/messages`, {
            method: 'POST',
            headers: {
              Authorization: `Bot ${botToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              content: fallbackContent,
              allowed_mentions: { parse: ['users'], replied_user: true },
            }),
          });
        }
      }
    }

    if (!res || !res.ok) {
      console.error(
        '[ForumSync] Failed to post comment to Discord thread:',
        res?.status,
        res ? await res.text() : 'no response',
      );
      return null;
    }

    const msg = (await res.json()) as { id: string };

    // Store discordMessageId on the comment row
    await db()
      .update(comments)
      .set({ discordMessageId: msg.id })
      .where(eq(comments.id, comment.id));

    return msg.id;
  } catch (err) {
    console.error('[ForumSync] Exception in syncCommentToDiscord:', err);
    return null;
  }
}

/**
 * Edit a synced comment in the Discord Forum Thread
 */
export async function editCommentInDiscord(
  threadId: string,
  discordMessageId: string,
  newBody: string,
  authorUsername: string,
  cfg?: Config,
): Promise<boolean> {
  const c = cfg ?? (await readConfig());
  const botToken = c.discord_bot_token;
  if (!botToken || !threadId || !discordMessageId) return false;

  try {
    // Try to patch the message content directly (works if it was sent by our bot)
    const res = await fetch(`${DISCORD_API}/channels/${threadId}/messages/${discordMessageId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: `${newBody} *(edited by ${authorUsername})*`,
      }),
    });
    return res.ok;
  } catch (err) {
    console.error('[ForumSync] Exception in editCommentInDiscord:', err);
    return false;
  }
}

/**
 * Delete a synced comment from the Discord Forum Thread
 */
export async function deleteCommentFromDiscord(
  threadId: string,
  discordMessageId: string,
  cfg?: Config,
): Promise<boolean> {
  const c = cfg ?? (await readConfig());
  const botToken = c.discord_bot_token;
  if (!botToken || !threadId || !discordMessageId) return false;

  try {
    const res = await fetch(`${DISCORD_API}/channels/${threadId}/messages/${discordMessageId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bot ${botToken}` },
    });
    return res.ok;
  } catch (err) {
    console.error('[ForumSync] Exception in deleteCommentFromDiscord:', err);
    return false;
  }
}

/**
 * Backfill & sync existing reports that don't have a Discord Forum thread yet.
 */
export async function syncExistingReports(
  origin: string,
  limit = 50,
  cfg?: Config,
): Promise<{ success: number; failed: number; commentsSynced: number; totalUnsynced: number }> {
  const c = cfg ?? (await readConfig());
  const d = db();

  let success = 0;
  let failed = 0;
  let commentsSynced = 0;

  // Step 1: Create threads for any reports missing a Discord thread
  const unsynced = await d
    .select()
    .from(reports)
    .where(isNull(reports.discordThreadId))
    .orderBy(asc(reports.id))
    .limit(limit);

  for (const report of unsynced) {
    try {
      const res = await createForumThread(report, origin, c);
      if (res) {
        success++;
      } else {
        failed++;
      }
    } catch (err) {
      console.error(`[ForumSync] Error syncing report #${report.id}:`, err);
      failed++;
    }

    // Rate-limit pause between thread creations (Discord forum limit is 30/min)
    await new Promise((r) => setTimeout(r, 800));
  }

  // Step 2: Sync ALL unsynced comments for ANY report that has a discordThreadId
  // (This handles reports whose threads were already created, like Report #3!)
  const unsyncedComments = await d
    .select({
      comment: comments,
      reportDiscordThreadId: reports.discordThreadId,
      reportKind: reports.kind,
      reportId: reports.id,
      user: users,
    })
    .from(comments)
    .innerJoin(reports, eq(reports.id, comments.reportId))
    .innerJoin(users, eq(users.discordId, comments.userId))
    .where(
      and(
        isNotNull(reports.discordThreadId),
        isNull(comments.discordMessageId),
      ),
    )
    .orderBy(asc(comments.createdAt))
    .limit(100);

  for (const item of unsyncedComments) {
    try {
      const commAtts = await d
        .select()
        .from(attachments)
        .where(eq(attachments.commentId, item.comment.id));
      const attUrls = commAtts.map((a) =>
        a.filePath.startsWith('http')
          ? a.filePath
          : `${origin}/${a.filePath.replace(/^\/+/, '')}`,
      );

      const msgId = await syncCommentToDiscord(
        {
          id: item.reportId,
          discordThreadId: item.reportDiscordThreadId,
          kind: item.reportKind,
        },
        item.comment,
        item.user,
        attUrls.length ? attUrls : undefined,
        c,
      );

      if (msgId) {
        commentsSynced++;
      } else {
        console.warn(`[ForumSync] Could not post comment #${item.comment.id} to thread`);
      }
    } catch (err) {
      console.error(`[ForumSync] Error syncing comment #${item.comment.id}:`, err);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  return { success, failed, commentsSynced, totalUnsynced: unsynced.length };
}

/**
 * Forward a newly uploaded attachment to the Discord Forum Thread as a plain
 * message (or multipart file upload) so Discord embeds images/videos natively.
 */
export async function syncAttachmentToDiscord(
  reportId: number,
  filePath: string,
  fileName: string,
  fileType: string,
  origin: string,
  uploaderUsername?: string,
  cfg?: Config,
  fileBuffer?: ArrayBuffer,
  mimeType?: string,
): Promise<boolean> {
  const c = cfg ?? (await readConfig());
  if (c.discord_forum_sync_enabled !== '1') return false;
  const botToken = c.discord_bot_token;
  if (!botToken) return false;

  const [report] = await db()
    .select({ discordThreadId: reports.discordThreadId })
    .from(reports)
    .where(eq(reports.id, reportId));

  if (!report?.discordThreadId) return false;

  try {
    const fileUrl = filePath.startsWith('http')
      ? filePath
      : `${origin}/${filePath.replace(/^\/+/, '')}`;
    const byLine = uploaderUsername ? ` by **${uploaderUsername}**` : '';
    const content = `📎 **${fileName}**${byLine}\n${fileUrl}`;

    if (fileBuffer && fileBuffer.byteLength > 0 && fileBuffer.byteLength < 25 * 1024 * 1024) {
      const form = new FormData();
      form.append(
        'payload_json',
        JSON.stringify({
          content: content.slice(0, 2000),
          allowed_mentions: { parse: [] },
        }),
      );
      form.append(
        'files[0]',
        new Blob([fileBuffer], { type: mimeType || 'application/octet-stream' }),
        fileName,
      );

      await fetch(`${DISCORD_API}/channels/${report.discordThreadId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${botToken}` },
        body: form,
      });
    } else {
      await fetch(`${DISCORD_API}/channels/${report.discordThreadId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: content.slice(0, 2000),
          allowed_mentions: { parse: [] },
        }),
      });
    }

    return true;
  } catch (err) {
    console.error('[ForumSync] Exception in syncAttachmentToDiscord:', err);
    return false;
  }
}

/**
 * Sync status from Discord Thread applied tags back to report.
 * Returns the updated status if changed, or null.
 */
export async function syncReportStatusFromDiscord(
  report: Pick<Report, 'id' | 'kind' | 'status' | 'discordThreadId'>,
  cfg?: Config,
): Promise<Status | null> {
  const c = cfg ?? (await readConfig());
  if (c.discord_forum_sync_enabled !== '1') return null;

  const botToken = c.discord_bot_token;
  if (!botToken || !report.discordThreadId) return null;

  const channelId = getForumChannelId(report.kind, c);
  if (!channelId) return null;

  try {
    const threadRes = await fetch(`${DISCORD_API}/channels/${report.discordThreadId}`, {
      headers: { Authorization: `Bot ${botToken}` },
    });

    if (!threadRes.ok) return null;
    const threadData = (await threadRes.json()) as DiscordChannel;
    const appliedTags = threadData.applied_tags || [];
    if (appliedTags.length === 0) return null;

    const tagsMap = await ensureForumTags(channelId, botToken, report.kind);
    // Invert tagsMap: tagId -> tagName
    const idToName = new Map<string, string>();
    for (const [name, id] of tagsMap.entries()) {
      idToName.set(id, name);
    }

    let targetStatus: Status | null = null;
    for (const tagId of appliedTags) {
      const name = idToName.get(tagId);
      if (!name) continue;

      if (name === 'fixed' || name === 'completed') targetStatus = 'fixed';
      else if (name === 'in progress') targetStatus = 'in_progress';
      else if (name === 'planned') targetStatus = 'confirmed';
      else if (name === 'under review') targetStatus = 'under_review';
      else if (name === 'open') targetStatus = 'open';
      else if (name === 'confirmed') targetStatus = 'confirmed';
      else if (name === "won't fix" || name === 'declined') targetStatus = 'wont_fix';
      else if (name === 'duplicate') targetStatus = 'duplicate';
    }

    if (targetStatus && targetStatus !== report.status) {
      await db()
        .update(reports)
        .set({
          status: targetStatus,
          statusChangedAt: sql`(unixepoch())`,
          updatedAt: sql`(unixepoch())`,
        })
        .where(eq(reports.id, report.id));

      console.log(`[ForumSync] Auto-synced status from Discord for report #${report.id}: ${report.status} -> ${targetStatus}`);
      return targetStatus;
    }
  } catch (err) {
    console.error('[ForumSync] Failed to sync status from Discord:', err);
  }

  return null;
}


