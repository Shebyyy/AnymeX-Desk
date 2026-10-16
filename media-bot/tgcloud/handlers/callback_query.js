import { api, db } from 'sdk';
import { eq, and } from 'sdk/db';
import { userSubscriptions } from '../schema.js';
import { searchMedia, getMediaById, getAiringSchedule } from '../lib/anilist.js';
import { formatMediaCard, formatAiringList, escapeHtml } from '../lib/formatters.js';
import { mediaCardKeyboard, mainMenuKeyboard } from '../lib/keyboards.js';
import { safeEditMessageText, safeSendMessage } from '../lib/telegram_helpers.js';

export default async function (callbackQuery) {
  try {
    const data = callbackQuery.data || '';
    const message = callbackQuery.message;
    const user = callbackQuery.from;
    const chatId = message?.chat?.id;
    const messageId = message?.message_id;

    if (!chatId || !user) return;

    // 1. Toggle Tracking
    if (data.startsWith('track:')) {
      const [, type, idStr] = data.split(':');
      const mediaId = Number(idStr);

      const existing = await db
        .select()
        .from(userSubscriptions)
        .where(and(eq(userSubscriptions.userId, user.id), eq(userSubscriptions.mediaId, mediaId)))
        .get();

      if (existing) {
        // Remove tracking
        await db
          .delete(userSubscriptions)
          .where(and(eq(userSubscriptions.userId, user.id), eq(userSubscriptions.mediaId, mediaId)))
          .run();

        await api.answerCallbackQuery({
          callback_query_id: callbackQuery.id,
          text: `🔕 Stopped tracking releases for this title.`,
        });

        const media = await getMediaById(mediaId);
        if (media && messageId) {
          await safeEditMessageText({
            chat_id: chatId,
            message_id: messageId,
            text: formatMediaCard(media, false),
            parse_mode: 'HTML',
            reply_markup: mediaCardKeyboard(media, false),
          });
        }
      } else {
        // Add tracking
        const media = await getMediaById(mediaId);
        if (!media) {
          await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'Could not fetch media info.' });
          return;
        }

        const title = media.title?.english || media.title?.romaji || 'Unknown';
        await db.insert(userSubscriptions).values({
          userId: user.id,
          chatId,
          mediaId,
          mediaType: type || media.type,
          title,
          coverImage: media.coverImage?.large,
          lastAiredEpisode: media.nextAiringEpisode?.episode ? media.nextAiringEpisode.episode - 1 : null,
          createdAt: Math.floor(Date.now() / 1000),
        }).run();

        await api.answerCallbackQuery({
          callback_query_id: callbackQuery.id,
          text: `🔔 Now tracking "${title}"! You will receive a DM when new releases drop.`,
          show_alert: true,
        });

        if (messageId) {
          await safeEditMessageText({
            chat_id: chatId,
            message_id: messageId,
            text: formatMediaCard(media, true),
            parse_mode: 'HTML',
            reply_markup: mediaCardKeyboard(media, true),
          });
        }
      }
      return;
    }

    // 2. Pagination
    if (data.startsWith('page:')) {
      const [, type, encodedQuery, pageStr] = data.split(':');
      const query = decodeURIComponent(encodedQuery || '');
      const page = Number(pageStr);

      const isNovel = type === 'NOVEL';
      const actualType = isNovel ? 'MANGA' : type;
      const format = isNovel ? 'NOVEL' : null;

      const result = await searchMedia({ query, type: actualType, format, page, perPage: 1 });
      const media = result.media && result.media.length > 0 ? result.media[0] : null;

      if (!media) {
        await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'No more results.' });
        return;
      }

      const total = result.pageInfo?.total || 1;
      const tracked = await db
        .select()
        .from(userSubscriptions)
        .where(and(eq(userSubscriptions.userId, user.id), eq(userSubscriptions.mediaId, media.id)))
        .get();

      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
      await safeEditMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: formatMediaCard(media, Boolean(tracked)),
        parse_mode: 'HTML',
        reply_markup: mediaCardKeyboard(media, Boolean(tracked), page, total, query, type),
      });
      return;
    }

    // 3. Navigation: Airing Schedule
    if (data === 'nav:airing') {
      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'Fetching schedule...' });
      const schedules = await getAiringSchedule(10);
      await safeSendMessage({
        chat_id: chatId,
        text: formatAiringList(schedules),
        parse_mode: 'HTML',
      });
      return;
    }

    // 4. Navigation: My Tracked Titles
    if (data === 'nav:mytracks') {
      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
      const tracks = await db
        .select()
        .from(userSubscriptions)
        .where(eq(userSubscriptions.userId, user.id))
        .all();

      if (tracks.length === 0) {
        await safeSendMessage({
          chat_id: chatId,
          text: `🔔 <b>You are not tracking any titles yet.</b>\n\nSearch any anime or manga with /anime or /manga and tap <b>Track New Releases</b>!`,
          parse_mode: 'HTML',
        });
        return;
      }

      let text = `🔔 <b>Your Tracked Titles (${tracks.length}):</b>\n\n`;
      const buttons = [];
      tracks.forEach((t, i) => {
        text += `${i + 1}. <b>${escapeHtml(t.title)}</b> (${t.mediaType})\n`;
        buttons.push([
          { text: `🔕 Untrack "${t.title.substring(0, 20)}"`, callback_data: `track:${t.mediaType}:${t.mediaId}` },
        ]);
      });

      await safeSendMessage({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons },
      });
      return;
    }

    // 5. Prompts
    if (data === 'prompt:anime') {
      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
      await safeSendMessage({
        chat_id: chatId,
        text: '🎬 <b>Search Anime:</b>\nSend <code>/anime &lt;title&gt;</code> (e.g. <code>/anime Frieren</code>)',
        parse_mode: 'HTML',
      });
      return;
    }

    if (data === 'prompt:manga') {
      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
      await safeSendMessage({
        chat_id: chatId,
        text: '📖 <b>Search Manga:</b>\nSend <code>/manga &lt;title&gt;</code> (e.g. <code>/manga Chainsaw Man</code>)',
        parse_mode: 'HTML',
      });
      return;
    }

    if (data === 'prompt:novel') {
      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
      await safeSendMessage({
        chat_id: chatId,
        text: '📚 <b>Search Light Novel:</b>\nSend <code>/novel &lt;title&gt;</code> (e.g. <code>/novel Mushoku Tensei</code>)',
        parse_mode: 'HTML',
      });
      return;
    }

    if (data === 'prompt:sauce') {
      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
      await safeSendMessage({
        chat_id: chatId,
        text: '🔍 <b>Sauce / Reverse Image Finder:</b>\nSend or forward any screenshot or image to find the anime, episode, and exact timestamp!',
        parse_mode: 'HTML',
      });
      return;
    }

    if (data === 'noop') {
      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
      return;
    }

    await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
  } catch (err) {
    console.error('handlers/callback_query error:', err);
    try {
      await api.answerCallbackQuery({
        callback_query_id: callbackQuery.id,
        text: 'An error occurred.',
        show_alert: false,
      });
    } catch {}
  }
}
