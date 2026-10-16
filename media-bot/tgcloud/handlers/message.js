import { api, db } from 'sdk';
import { eq, and } from 'sdk/db';
import { userSubscriptions, userSettings } from '../schema.js';
import { searchMedia, getMediaById, getAiringSchedule, getUserCurrentList } from '../lib/anilist.js';
import { searchSauce } from '../lib/tracemoe.js';
import { formatMediaCard, formatSauceCard, formatAiringList, escapeHtml } from '../lib/formatters.js';
import { mediaCardKeyboard, sauceKeyboard, mainMenuKeyboard } from '../lib/keyboards.js';
import { safeSendMessage, safeSendPhoto } from '../lib/telegram_helpers.js';
import { COMMANDS, BOT_NAME } from '../lib/constants.js';

export default async function (message) {
  try {
    const chatId = message?.chat?.id;
    const userId = message?.from?.id;
    const user = message?.from;
    if (!chatId || !userId) return;

    const rawText = (message.text || message.caption || '').trim();
    // Strip bot mention if in group (/anime@AnymeXMediaBot -> /anime)
    const text = rawText.replace(/^(\/[a-zA-Z0-9_]+)@\w+bot\b/i, '$1');

    const photo = message.photo && message.photo.length > 0 ? message.photo[message.photo.length - 1] : null;

    // ─────────────────────────────────────────────────────────────────────────────
    // 1. REVERSE IMAGE SEARCH (Sauce Finder)
    // ─────────────────────────────────────────────────────────────────────────────
    if (photo) {
      const statusMsg = await safeSendMessage({
        chat_id: chatId,
        text: '🔍 <b>Scanning scene with trace.moe...</b>',
        parse_mode: 'HTML',
        reply_to_message_id: message.message_id,
      });

      try {
        const imageBytes = await api.getFileContent(photo.file_id);
        if (!imageBytes) {
          await safeSendMessage({
            chat_id: chatId,
            text: '⚠️ Could not retrieve image from Telegram. Please try again.',
            reply_to_message_id: message.message_id,
          });
          return;
        }

        const matches = await searchSauce(imageBytes);

        if (!matches || matches.length === 0 || matches[0].similarity < 0.70) {
          await safeSendMessage({
            chat_id: chatId,
            text: '❌ <b>No anime scene match found.</b>\n\nMake sure the image is an uncropped anime screenshot (not fanart, manga, or heavily edited).',
            parse_mode: 'HTML',
            reply_to_message_id: message.message_id,
          });
          return;
        }

        const topMatch = matches[0];
        let anilistMedia = null;
        if (topMatch.anilist) {
          anilistMedia = await getMediaById(topMatch.anilist);
        }

        const textResult = formatSauceCard(topMatch, anilistMedia);
        const kb = sauceKeyboard(topMatch.anilist, topMatch.video);

        if (topMatch.image) {
          await safeSendPhoto({
            chat_id: chatId,
            photo: topMatch.image,
            caption: textResult,
            parse_mode: 'HTML',
            reply_markup: kb,
          });
        } else {
          await safeSendMessage({
            chat_id: chatId,
            text: textResult,
            parse_mode: 'HTML',
            reply_markup: kb,
          });
        }
      } catch (err) {
        console.error('Sauce search error:', err);
        await safeSendMessage({
          chat_id: chatId,
          text: '❌ Reverse search failed. Please try a different screenshot.',
          reply_to_message_id: message.message_id,
        });
      }
      return;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // 2. SLASH COMMANDS
    // ─────────────────────────────────────────────────────────────────────────────

    // /start & /help
    if (text.startsWith('/start') || text.startsWith('/help')) {
      // Register bot commands popup
      try {
        await api.setMyCommands({ commands: COMMANDS });
      } catch {}

      const welcome =
        `👋 <b>Welcome to ${BOT_NAME}!</b>\n\n` +
        `Your all-in-one companion for <b>Anime, Manga, and Light Novels</b> with direct streaming & reading deep links to the <b>AnymeX app</b>.\n\n` +
        `<b>⚡ Features:</b>\n` +
        `• <b>Instant Search:</b> Use /anime, /manga, /novel, or inline query in any chat!\n` +
        `• <b>Sauce Finder:</b> Send any anime screenshot to identify the exact scene, episode, and timestamp.\n` +
        `• <b>Release Alerts:</b> Get notified the moment new episodes or chapters drop.\n` +
        `• <b>AniList Sync:</b> Import your watching list with <code>/sync &lt;username&gt;</code>\n\n` +
        `<i>Choose an option below or type a title to search:</i>`;

      await safeSendMessage({
        chat_id: chatId,
        text: welcome,
        parse_mode: 'HTML',
        reply_markup: mainMenuKeyboard(),
      });
      return;
    }

    // /anime <title>
    if (text.startsWith('/anime')) {
      const query = text.replace(/^\/anime\s*/i, '').trim();
      if (!query) {
        await safeSendMessage({
          chat_id: chatId,
          text: '💡 <b>Usage:</b> <code>/anime &lt;title&gt;</code>\nExample: <code>/anime Solo Leveling</code>',
          parse_mode: 'HTML',
        });
        return;
      }

      const result = await searchMedia({ query, type: 'ANIME', page: 1, perPage: 1 });
      const media = result.media && result.media.length > 0 ? result.media[0] : null;

      if (!media) {
        await safeSendMessage({
          chat_id: chatId,
          text: `❌ No anime found matching "<b>${escapeHtml(query)}</b>".`,
          parse_mode: 'HTML',
        });
        return;
      }

      const isTracked = await db
        .select()
        .from(userSubscriptions)
        .where(and(eq(userSubscriptions.userId, userId), eq(userSubscriptions.mediaId, media.id)))
        .get();

      const total = result.pageInfo?.total || 1;
      const card = formatMediaCard(media, Boolean(isTracked));
      const kb = mediaCardKeyboard(media, Boolean(isTracked), 1, total, query, 'ANIME');

      if (media.coverImage?.extraLarge || media.coverImage?.large) {
        await safeSendPhoto({
          chat_id: chatId,
          photo: media.coverImage.extraLarge || media.coverImage.large,
          caption: card,
          parse_mode: 'HTML',
          reply_markup: kb,
        });
      } else {
        await safeSendMessage({
          chat_id: chatId,
          text: card,
          parse_mode: 'HTML',
          reply_markup: kb,
        });
      }
      return;
    }

    // /manga <title>
    if (text.startsWith('/manga')) {
      const query = text.replace(/^\/manga\s*/i, '').trim();
      if (!query) {
        await safeSendMessage({
          chat_id: chatId,
          text: '💡 <b>Usage:</b> <code>/manga &lt;title&gt;</code>\nExample: <code>/manga Berserk</code>',
          parse_mode: 'HTML',
        });
        return;
      }

      const result = await searchMedia({ query, type: 'MANGA', page: 1, perPage: 1 });
      const media = result.media && result.media.length > 0 ? result.media[0] : null;

      if (!media) {
        await safeSendMessage({
          chat_id: chatId,
          text: `❌ No manga found matching "<b>${escapeHtml(query)}</b>".`,
          parse_mode: 'HTML',
        });
        return;
      }

      const isTracked = await db
        .select()
        .from(userSubscriptions)
        .where(and(eq(userSubscriptions.userId, userId), eq(userSubscriptions.mediaId, media.id)))
        .get();

      const total = result.pageInfo?.total || 1;
      const card = formatMediaCard(media, Boolean(isTracked));
      const kb = mediaCardKeyboard(media, Boolean(isTracked), 1, total, query, 'MANGA');

      if (media.coverImage?.extraLarge || media.coverImage?.large) {
        await safeSendPhoto({
          chat_id: chatId,
          photo: media.coverImage.extraLarge || media.coverImage.large,
          caption: card,
          parse_mode: 'HTML',
          reply_markup: kb,
        });
      } else {
        await safeSendMessage({
          chat_id: chatId,
          text: card,
          parse_mode: 'HTML',
          reply_markup: kb,
        });
      }
      return;
    }

    // /novel <title>
    if (text.startsWith('/novel')) {
      const query = text.replace(/^\/novel\s*/i, '').trim();
      if (!query) {
        await safeSendMessage({
          chat_id: chatId,
          text: '💡 <b>Usage:</b> <code>/novel &lt;title&gt;</code>\nExample: <code>/novel Classroom of the Elite</code>',
          parse_mode: 'HTML',
        });
        return;
      }

      const result = await searchMedia({ query, type: 'MANGA', format: 'NOVEL', page: 1, perPage: 1 });
      const media = result.media && result.media.length > 0 ? result.media[0] : null;

      if (!media) {
        await safeSendMessage({
          chat_id: chatId,
          text: `❌ No light novel found matching "<b>${escapeHtml(query)}</b>".`,
          parse_mode: 'HTML',
        });
        return;
      }

      const isTracked = await db
        .select()
        .from(userSubscriptions)
        .where(and(eq(userSubscriptions.userId, userId), eq(userSubscriptions.mediaId, media.id)))
        .get();

      const total = result.pageInfo?.total || 1;
      const card = formatMediaCard(media, Boolean(isTracked));
      const kb = mediaCardKeyboard(media, Boolean(isTracked), 1, total, query, 'NOVEL');

      if (media.coverImage?.extraLarge || media.coverImage?.large) {
        await safeSendPhoto({
          chat_id: chatId,
          photo: media.coverImage.extraLarge || media.coverImage.large,
          caption: card,
          parse_mode: 'HTML',
          reply_markup: kb,
        });
      } else {
        await safeSendMessage({
          chat_id: chatId,
          text: card,
          parse_mode: 'HTML',
          reply_markup: kb,
        });
      }
      return;
    }

    // /airing
    if (text.startsWith('/airing') || text.startsWith('/schedule')) {
      const schedules = await getAiringSchedule(10);
      await safeSendMessage({
        chat_id: chatId,
        text: formatAiringList(schedules),
        parse_mode: 'HTML',
      });
      return;
    }

    // /sauce
    if (text.startsWith('/sauce')) {
      await safeSendMessage({
        chat_id: chatId,
        text: '🔍 <b>Sauce / Reverse Image Finder:</b>\n\nSimply send or forward any anime screenshot into this chat to identify the anime, episode number, and exact scene timestamp!',
        parse_mode: 'HTML',
      });
      return;
    }

    // /mytracks
    if (text.startsWith('/mytracks') || text.startsWith('/subscriptions')) {
      const tracks = await db
        .select()
        .from(userSubscriptions)
        .where(eq(userSubscriptions.userId, userId))
        .all();

      if (tracks.length === 0) {
        await safeSendMessage({
          chat_id: chatId,
          text: '🔔 <b>You have no active release alerts.</b>\n\nSearch any title with /anime or /manga and tap <b>Track New Releases</b>!',
          parse_mode: 'HTML',
        });
        return;
      }

      let resText = `🔔 <b>Your Active Subscriptions (${tracks.length}):</b>\n\n`;
      const buttons = [];
      tracks.forEach((t, i) => {
        resText += `${i + 1}. <b>${escapeHtml(t.title)}</b> (${t.mediaType})\n`;
        buttons.push([
          { text: `🔕 Untrack "${t.title.substring(0, 20)}"`, callback_data: `track:${t.mediaType}:${t.mediaId}` },
        ]);
      });

      await safeSendMessage({
        chat_id: chatId,
        text: resText,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons },
      });
      return;
    }

    // /sync <anilistUsername>
    if (text.startsWith('/sync')) {
      const username = text.replace(/^\/sync\s*/i, '').trim();
      if (!username) {
        await safeSendMessage({
          chat_id: chatId,
          text: '💡 <b>Usage:</b> <code>/sync &lt;AniList_Username&gt;</code>\n\nImports all titles currently in your "Watching" and "Reading" lists for release alerts!',
          parse_mode: 'HTML',
        });
        return;
      }

      const syncMsg = await safeSendMessage({
        chat_id: chatId,
        text: `🔄 <b>Syncing current list from AniList user "${escapeHtml(username)}"...</b>`,
        parse_mode: 'HTML',
      });

      const { anime, manga } = await getUserCurrentList(username);
      const total = anime.length + manga.length;

      if (total === 0) {
        await safeSendMessage({
          chat_id: chatId,
          text: `⚠️ No currently watching or reading titles found for user "<b>${escapeHtml(username)}</b>". Check your AniList privacy settings or username spelling.`,
          parse_mode: 'HTML',
        });
        return;
      }

      let added = 0;
      for (const item of [...anime, ...manga]) {
        const title = item.title?.english || item.title?.romaji || 'Unknown';
        const exists = await db
          .select()
          .from(userSubscriptions)
          .where(and(eq(userSubscriptions.userId, userId), eq(userSubscriptions.mediaId, item.id)))
          .get();

        if (!exists) {
          await db.insert(userSubscriptions).values({
            userId,
            chatId,
            mediaId: item.id,
            mediaType: item.type,
            title,
            lastAiredEpisode: item.nextAiringEpisode?.episode ? item.nextAiringEpisode.episode - 1 : null,
            createdAt: Math.floor(Date.now() / 1000),
          }).run();
          added++;
        }
      }

      // Save username in settings
      const existingSettings = await db.select().from(userSettings).where(eq(userSettings.userId, userId)).get();
      if (existingSettings) {
        await db.update(userSettings).set({ anilistUsername: username }).where(eq(userSettings.userId, userId)).run();
      } else {
        await db.insert(userSettings).values({
          userId,
          anilistUsername: username,
          notificationsEnabled: 1,
          createdAt: Math.floor(Date.now() / 1000),
        }).run();
      }

      await safeSendMessage({
        chat_id: chatId,
        text: `✅ <b>AniList Sync Complete!</b>\n\nFound <b>${total}</b> active titles (${anime.length} Anime, ${manga.length} Manga).\nAdded <b>${added}</b> new release subscriptions to your alerts.`,
        parse_mode: 'HTML',
      });
      return;
    }

    // Default fallback: If user types plain text, treat as search
    if (text && !text.startsWith('/')) {
      const result = await searchMedia({ query: text, type: 'ANIME', page: 1, perPage: 1 });
      const media = result.media && result.media.length > 0 ? result.media[0] : null;

      if (media) {
        const isTracked = await db
          .select()
          .from(userSubscriptions)
          .where(and(eq(userSubscriptions.userId, userId), eq(userSubscriptions.mediaId, media.id)))
          .get();

        const total = result.pageInfo?.total || 1;
        const card = formatMediaCard(media, Boolean(isTracked));
        const kb = mediaCardKeyboard(media, Boolean(isTracked), 1, total, text, 'ANIME');

        if (media.coverImage?.extraLarge || media.coverImage?.large) {
          await safeSendPhoto({
            chat_id: chatId,
            photo: media.coverImage.extraLarge || media.coverImage.large,
            caption: card,
            parse_mode: 'HTML',
            reply_markup: kb,
          });
        } else {
          await safeSendMessage({
            chat_id: chatId,
            text: card,
            parse_mode: 'HTML',
            reply_markup: kb,
          });
        }
        return;
      }
    }

  } catch (err) {
    console.error('handlers/message uncaught error:', err);
  }
}
