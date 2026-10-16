import { table, integer, text, boolean, sql, index } from 'sdk/db';

/**
 * In-progress report wizard draft for each Telegram user.
 * Stores multi-step conversational state until submission to AnymeX Desk.
 */
export const reportDrafts = table('report_drafts', {
  userId: integer('user_id').primaryKey(),
  kind: text('kind'),                        // 'bug' | 'suggestion' | 'extension'
  step: text('step'),                        // wizard step: 'category', 'platform', 'version', 'title', 'steps', 'body', 'ext_name', 'ext_issue'
  category: text('category'),
  platform: text('platform'),
  releaseChannel: text('release_channel').default('stable'),
  appVersion: text('app_version'),
  pluginVersion: text('plugin_version'),
  title: text('title'),
  stepsToReproduce: text('steps_to_reproduce'),
  body: text('body'),
  testedNativeApp: boolean('tested_native_app').default(false),
  extensionNames: text('extension_names'),    // JSON stringified array of { name, version, issue }
  extensionRepo: text('extension_repo'),
  attachments: text('attachments'),          // JSON stringified array of { type, file_id, file_name }
  updatedAt: integer('updated_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});

/**
 * Report watchers subscription table.
 * Telegram users subscribe to specific Desk reports to receive DMs when status changes.
 */
export const watchers = table('watchers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  chatId: integer('chat_id').notNull(),
  reportId: integer('report_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
}, (t) => ({
  userReportIdx: index('idx_watchers_user_report').on(t.userId, t.reportId),
  reportIdx: index('idx_watchers_report').on(t.reportId),
}));

/**
 * Registered staff members for in-chat triage authorizations.
 */
export const staffMembers = table('staff_members', {
  userId: integer('user_id').primaryKey(),
  role: text('role').notNull().default('mod'), // 'mod' | 'admin'
  addedAt: integer('added_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
});
