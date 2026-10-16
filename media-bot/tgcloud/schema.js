import { table, integer, text } from 'sdk/db';

export const userSubscriptions = table('user_subscriptions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  chatId: integer('chat_id').notNull(),
  mediaId: integer('media_id').notNull(),
  mediaType: text('media_type').notNull(), // 'ANIME' | 'MANGA'
  title: text('title').notNull(),
  coverImage: text('cover_image'),
  lastAiredEpisode: integer('last_aired_episode'),
  createdAt: integer('created_at').notNull(),
});

export const userSettings = table('user_settings', {
  userId: integer('user_id').primaryKey(),
  anilistUsername: text('anilist_username'),
  notificationsEnabled: integer('notifications_enabled').notNull().default(1),
  createdAt: integer('created_at').notNull(),
});
