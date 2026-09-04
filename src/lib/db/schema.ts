import { desc, sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * AnymeX Bug & Suggestion Tracker
 *
 * Tracks bugs and feature suggestions for the AnymeX app.
 * Users file reports with categories, platforms, media attachments.
 * Voting determines priority. Discord DMs notify reporters of status changes.
 */

// ─── Report kinds ───────────────────────────────────────────────────────────

export const KINDS = ['bug', 'suggestion', 'extension'] as const;

// ─── Bug categories ─────────────────────────────────────────────────────────

export const BUG_CATEGORIES = [
  'video_player',
  'ui_ux',
  'login_auth',
  'manga_reader',
  'extension_bridge',
  'crash',
  'performance',
  'novel_reader',
  'library',
  'tracking',
  'other',
] as const;

// ─── Suggestion categories ───────────────────────────────────────────────────

export const SUGGESTION_CATEGORIES = [
  'player',
  'ui_ux',
  'library',
  'tracking',
  'extensions',
  'manga_reader',
  'novel_reader',
  'download',
  'other',
] as const;

// ─── Extension issue sources ─────────────────────────────────────────────────
//
// "Category" for an extension-issue report is which source app the affected
// extension runs on. Mirrors the Discord ticket bot's "Extension type(s)
// affected" checkbox group, collapsed to a single pick to match this table's
// one-category-per-report shape (see the `reports_dedup` index).

export const EXTENSION_SOURCES = [
  'mihon_aniyomi',
  'mangayomi',
  'sora',
  'lnreader',
  'cloudstream',
  'kotatsu',
  'other',
] as const;

// ─── Platforms ──────────────────────────────────────────────────────────────

export const PLATFORMS = ['android', 'ios', 'windows', 'macos', 'linux', 'all'] as const;

// ─── Statuses ───────────────────────────────────────────────────────────────

export const STATUSES = [
  'open',
  'under_review',
  'confirmed',
  'in_progress',
  'fixed',
  'wont_fix',
  'duplicate',
] as const;

/** Statuses that still count as live demand — the dedupe window. */
export const OPEN_STATUSES = ['open', 'under_review', 'confirmed', 'in_progress'] as const;

/** Closed without a fix. */
export const OTHER_STATUSES = ['wont_fix', 'duplicate'] as const;

// ─── Staff tiers ────────────────────────────────────────────────────────────

export const STAFF_LEVELS = ['mod', 'admin'] as const;
export type StaffLevel = (typeof STAFF_LEVELS)[number];

// ─── Display labels ─────────────────────────────────────────────────────────

export const CATEGORY_LABELS: Record<string, string> = {
  video_player: 'Video Player',
  ui_ux: 'UI / UX',
  login_auth: 'Login / Auth',
  manga_reader: 'Manga Reader',
  extension_bridge: 'Extension / Bridge',
  crash: 'Crash',
  performance: 'Performance',
  novel_reader: 'Novel Reader',
  library: 'Library',
  tracking: 'Tracking',
  player: 'Player',
  extensions: 'Extensions',
  download: 'Download',
  other: 'Other',
  mihon_aniyomi: 'Mihon / Aniyomi',
  mangayomi: 'Mangayomi',
  sora: 'Sora',
  lnreader: 'LNReader',
  cloudstream: 'Cloudstream',
  kotatsu: 'Kotatsu',
};

export const PLATFORM_LABELS: Record<string, string> = {
  android: 'Android',
  ios: 'iOS',
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  all: 'All Platforms',
};

export const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  under_review: 'Under Review',
  confirmed: 'Confirmed',
  in_progress: 'In Progress',
  fixed: 'Fixed',
  wont_fix: "Won't Fix",
  duplicate: 'Duplicate',
};

export const KIND_LABELS: Record<string, string> = {
  bug: 'Bug',
  suggestion: 'Suggestion',
  extension: 'Extension Issue',
};

export const ROADMAP_STAGES = ['under_review', 'planned', 'in_progress', 'shipped'] as const;
export type RoadmapStage = (typeof ROADMAP_STAGES)[number];
export const ROADMAP_STAGE_LABELS: Record<RoadmapStage, string> = {
  under_review: 'Under Review',
  planned: 'Planned',
  in_progress: 'In Progress',
  shipped: 'Shipped',
};

// ═══════════════════════════════════════════════════════════════════════════════
// Tables
// ═══════════════════════════════════════════════════════════════════════════════

export const users = sqliteTable('users', {
  discordId: text('discord_id').primaryKey(),
  username: text('username').notNull(),
  avatarHash: text('avatar_hash'),
  /** Decoded from the Discord snowflake — no extra OAuth scope needed. */
  accountCreatedAt: integer('account_created_at').notNull(),
  guildJoinedAt: integer('guild_joined_at'),
  discordLevel: text('discord_level', { enum: STAFF_LEVELS }),
  manualLevel: text('manual_level', { enum: STAFF_LEVELS }),
  banned: integer('banned', { mode: 'boolean' }).notNull().default(false),
  firstSeen: integer('first_seen').notNull().default(sql`(unixepoch())`),
  lastLogin: integer('last_login').notNull().default(sql`(unixepoch())`),

  /** Discord account link state */
  discordLinked: integer('discord_linked', { mode: 'boolean' }).notNull().default(true),
  discordUserId: text('discord_user_id'),

  /** Telegram integration fields */
  telegramId: text('telegram_id'),
  telegramUsername: text('telegram_username'),
  telegramPhotoUrl: text('telegram_photo_url'),
  notifyTelegram: integer('notify_telegram', { mode: 'boolean' }).notNull().default(true),
  notifyDiscord: integer('notify_discord', { mode: 'boolean' }).notNull().default(true),
});

export const reports = sqliteTable(
  'reports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: KINDS }).notNull(),

    /** Which area of the app this report targets. */
    category: text('category').notNull(),

    /** Which platform(s) the bug occurs on. */
    platform: text('platform', { enum: PLATFORMS }).notNull(),

    /** The AnymeX app version, e.g. "3.1.7+39". */
    appVersion: text('app_version'),

    title: text('title').notNull(),
    body: text('body'),

    /** For bugs: steps to reproduce the issue. */
    stepsToReproduce: text('steps_to_reproduce'),

    /**
     * For extension-issue reports only, mirroring the Discord ticket bot form:
     */
    /** Gate: reporter confirms the extension works in its native app and only fails in AnymeX. */
    testedNativeApp: integer('tested_native_app', { mode: 'boolean' }),
    /** Exact name(s) of the affected extension(s), one per line. */
    extensionNames: text('extension_names'),
    /** Optional link to the extension's repository. */
    extensionRepo: text('extension_repo'),

    status: text('status', { enum: STATUSES }).notNull().default('open'),
    reporterId: text('reporter_id')
      .notNull()
      .references(() => users.discordId),

    duplicateOf: integer('duplicate_of'),

    /**
     * Denormalised counter, moved only by lib/vote.ts in the same D1 batch
     * as the vote row. Never recomputed.
     */
    votes: integer('votes').notNull().default(0),

    /** How many attachments this report has (denormalised for board display). */
    attachmentCount: integer('attachment_count').notNull().default(0),
    /** How many comments this report has (denormalised for board display). */
    commentCount: integer('comment_count').notNull().default(0),

    createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
    editedAt: integer('edited_at'),
    statusChangedAt: integer('status_changed_at'),

    /** When this report was announced to Discord as high-demand. */
    announcedAt: integer('announced_at'),

    statusNote: text('status_note'),
    roadmapStage: text('roadmap_stage', {
      enum: ['under_review', 'planned', 'in_progress', 'shipped'],
    }),
    milestone: text('milestone'),

    /** Discord Contributor Forum sync fields */
    discordThreadId: text('discord_thread_id'),
    discordStarterMessageId: text('discord_starter_message_id'),
    /** Unix timestamp of the last cron poll for this thread. */
    discordLastPolledAt: integer('discord_last_polled_at'),
    /** Snowflake of the newest Discord message seen — used as `after` cursor. */
    discordLastMessageId: text('discord_last_message_id'),
  },
  (t) => [
    /**
     * Dedup: one open report per kind + category + platform + normalized title.
     * The title_hash is a lowercased, trimmed version stored at insert time.
     */
    uniqueIndex('reports_dedup')
      .on(t.kind, t.category, t.platform, t.title)
      .where(sql`status IN ('open', 'confirmed', 'in_progress')`),

    /** Board query index: matches the board's filter + sort order. */
    index('reports_board').on(t.status, t.kind, desc(t.votes), t.createdAt, t.category),

    /** Partial index for the default open board view — avoids temp B-tree sort. */
    index('reports_board_open')
      .on(desc(t.votes), t.createdAt, t.kind, t.category)
      .where(sql`status IN ('open', 'confirmed', 'in_progress')`),

    /** Covers the header tallies without touching the table. */
    index('reports_tallies').on(t.status, t.kind, t.createdAt),

    index('reports_by_reporter').on(t.reporterId),
    index('reports_by_category').on(t.category),
    index('reports_by_platform').on(t.platform),
    index('reports_by_age').on(t.status, t.createdAt),
    index('reports_by_discord_thread').on(t.discordThreadId),
  ],
);

export const votes = sqliteTable(
  'votes',
  {
    reportId: integer('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    discordId: text('discord_id')
      .notNull()
      .references(() => users.discordId, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    primaryKey({ columns: [t.reportId, t.discordId] }),
    index('votes_by_user').on(t.discordId),
  ],
);

/**
 * File attachments for reports — screenshots and screen recordings.
 *
 * Files are stored on disk (or R2 in production). This table tracks metadata.
 */
export const attachments = sqliteTable(
  'attachments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    reportId: integer('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    /** If set, this attachment belongs to a comment. NULL = report-level. */
    commentId: integer('comment_id'),
    /** Original filename as uploaded by the user. */
    fileName: text('file_name').notNull(),
    /** Path on disk / R2 key. */
    filePath: text('file_path').notNull(),
    /** image, video, or file. */
    fileType: text('file_type').notNull(),
    /** MIME type: image/png, video/mp4, text/plain, etc. */
    mimeType: text('mime_type').notNull(),
    /** File size in bytes. */
    fileSize: integer('file_size').notNull(),
    /** Image width in pixels (null for videos/files). */
    width: integer('width'),
    /** Image height in pixels (null for videos/files). */
    height: integer('height'),
    /** Thumbnail path for videos. */
    thumbnailPath: text('thumbnail_path'),
    /** Display order within the report. */
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
    /**
     * For attachments that came from Discord: the original Discord CDN URL.
     * Served via the uploads proxy route (302 redirect to CDN).
     */
    discordCdnUrl: text('discord_cdn_url'),
  },
  (t) => [
    index('attachments_by_report').on(t.reportId, t.sortOrder),
    index('attachments_by_comment').on(t.commentId),
  ],
);

/**
 * Comments on reports — for discussion between users and staff.
 */
export const comments = sqliteTable(
  'comments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    reportId: integer('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.discordId, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    /** If set, this comment is a reply to another comment on the same report. */
    replyToId: integer('reply_to_id'),
    /** Discord sync: message snowflake and origin */
    discordMessageId: text('discord_message_id'),
    source: text('source', { enum: ['web', 'discord'] }).notNull().default('web'),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index('comments_by_report').on(t.reportId, t.createdAt),
    index('comments_by_user').on(t.userId),
    index('comments_by_reply').on(t.replyToId),
    index('comments_by_discord_message').on(t.discordMessageId),
  ],
);

/**
 * In-app notifications for status changes on reports the user is involved in.
 */
export const notifications = sqliteTable(
  'notifications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: text('user_id')
      .notNull()
      .references(() => users.discordId, { onDelete: 'cascade' }),
    reportId: integer('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    kind: text('kind', {
      enum: ['status_changed', 'comment', 'duplicate', 'mentioned', 'subscription_match'],
    }).notNull(),
    detail: text('detail'),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
    readAt: integer('read_at'),
  },
  (t) => [index('notifications_unread').on(t.userId, t.readAt)],
);

/**
 * Runtime configuration, editable from /admin.
 * Key/value rather than one wide row — settings grow into a ragged set.
 * Every read falls back to an environment default.
 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
  updatedBy: text('updated_by'),
});

/**
 * Audit log for all staff actions — who did what, when.
 */
export const audit = sqliteTable(
  'audit',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    actorId: text('actor_id').notNull(),
    actorName: text('actor_name').notNull(),
    action: text('action').notNull(),
    target: text('target'),
    detail: text('detail'),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  },
  (t) => [index('audit_recent').on(t.createdAt)],
);

/**
 * Audit trail for every edit made to a report's content fields.
 * One row per field changed, so diffs are granular.
 */
export const reportEdits = sqliteTable(
  'report_edits',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    reportId: integer('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    editorId: text('editor_id').notNull(),
    /** Which field was changed: title | body | steps | category | platform */
    field: text('field').notNull(),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index('report_edits_by_report').on(t.reportId),
    index('report_edits_by_editor').on(t.editorId),
  ],
);

/**
 * Staff-managed labels / tags for reports.
 */
export const labels = sqliteTable('labels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  /** CSS hex color, e.g. #ef4444 */
  color: text('color').notNull().default('#6b7280'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
});

/** Many-to-many join between reports and labels. */
export const reportLabels = sqliteTable(
  'report_labels',
  {
    reportId: integer('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    labelId: integer('label_id')
      .notNull()
      .references(() => labels.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.reportId, t.labelId] }),
    index('report_labels_by_label').on(t.labelId),
    index('report_labels_by_report').on(t.reportId),
  ],
);

/**
 * User subscriptions to a saved filter.
 * A null dimension means "match any value" for that dimension.
 */
export const subscriptions = sqliteTable(
  'subscriptions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: text('user_id')
      .notNull()
      .references(() => users.discordId, { onDelete: 'cascade' }),
    /** null = all kinds */
    kind: text('kind'),
    /** null = all categories */
    category: text('category'),
    /** null = all platforms */
    platform: text('platform'),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  },
  (t) => [index('subscriptions_by_user').on(t.userId)],
);

/**
 * Emoji reactions on comments.
 */
export const commentReactions = sqliteTable(
  'comment_reactions',
  {
    commentId: integer('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    discordId: text('discord_id')
      .notNull()
      .references(() => users.discordId, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.commentId, t.discordId, t.emoji] }),
    index('reactions_by_comment').on(t.commentId),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export type User = typeof users.$inferSelect;
export type Report = typeof reports.$inferSelect;
export type NewReport = typeof reports.$inferInsert;
export type Vote = typeof votes.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
export type Comment = typeof comments.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type Setting = typeof settings.$inferSelect;
export type AuditEntry = typeof audit.$inferSelect;
export type ReportEdit = typeof reportEdits.$inferSelect;
export type Label = typeof labels.$inferSelect;
export type ReportLabel = typeof reportLabels.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type CommentReaction = typeof commentReactions.$inferSelect;

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** Normalize a title for dedup comparison. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[!?.,;:'"]+/g, '')
    .substring(0, 200);
}

/** Valid image MIME types. */
export const IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

/** Valid video MIME types. */
export const VIDEO_MIMES = new Set([
  'video/mp4',
  'video/webm',
]);

/** Max image size: 5MB. */
export const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
/** Max video size: 50MB. */
export const MAX_VIDEO_SIZE = 50 * 1024 * 1024;
/** Max images per report. */
export const MAX_IMAGES = 5;
/** Max videos per report. */
export const MAX_VIDEOS = 1;
