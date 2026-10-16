import { api, db } from 'sdk';
import { eq, and } from 'sdk/db';
import { reportDrafts, watchers } from '../schema.js';
import {
  platformKeyboard,
  releaseChannelKeyboard,
  categoryKeyboard,
  nativeAppGateKeyboard,
  skipOrCancelKeyboard,
  reportCardKeyboard,
  triageKeyboard,
} from '../lib/keyboards.js';
import {
  getReports,
  updateTriageStatus,
  toggleVote,
} from '../lib/desk_api.js';
import { formatReportList } from '../lib/formatters.js';
import { BOT_URL } from '../lib/constants.js';

export default async function (callbackQuery) {
  const data = callbackQuery.data || '';
  const message = callbackQuery.message;
  const user = callbackQuery.from;
  const chatId = message?.chat?.id;
  const messageId = message?.message_id;
  const isGroup = message?.chat?.type === 'group' || message?.chat?.type === 'supergroup';

  // In groups, redirect wizard starts directly to private DM
  if (isGroup && data.startsWith('start:')) {
    const kind = data.split(':')[1];
    await api.answerCallbackQuery({
      callback_query_id: callbackQuery.id,
      url: `${BOT_URL}?start=${kind}`,
    });
    return;
  }

  // 1. Wizard: Start a report
  if (data.startsWith('start:')) {
    const kind = data.split(':')[1]; // 'bug' | 'suggestion' | 'extension'

    // Reset draft
    await db.delete(reportDrafts).where(eq(reportDrafts.userId, user.id)).run();

    let nextPrompt = '';
    let markup;

    if (kind === 'bug') {
      await db.insert(reportDrafts).values({
        userId: user.id,
        kind: 'bug',
        step: 'platform',
      }).run();
      nextPrompt = '<b>🐛 Step 1/6: Select the platform where the bug occurs:</b>';
      markup = platformKeyboard('plat');
    } else if (kind === 'suggestion') {
      await db.insert(reportDrafts).values({
        userId: user.id,
        kind: 'suggestion',
        step: 'category',
      }).run();
      nextPrompt = '<b>💡 Step 1/4: Select the category for your feature suggestion:</b>';
      markup = categoryKeyboard('suggestion', 'cat');
    } else if (kind === 'extension') {
      await db.insert(reportDrafts).values({
        userId: user.id,
        kind: 'extension',
        step: 'source',
      }).run();
      nextPrompt = '<b>🧩 Step 1/5: Which extension source engine is having issues?</b>';
      markup = categoryKeyboard('extension', 'cat');
    }

    await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
    if (messageId && chatId) {
      await api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: nextPrompt,
        parse_mode: 'HTML',
        reply_markup: markup,
      });
    }
    return;
  }

  // 2. Wizard: Platform selected
  if (data.startsWith('plat:')) {
    const platform = data.split(':')[1];
    const draft = await db.select().from(reportDrafts).where(eq(reportDrafts.userId, user.id)).get();

    if (!draft) {
      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'Session expired. Please restart with /bug or /suggest.' });
      return;
    }

    if (draft.kind === 'bug') {
      await db.update(reportDrafts)
        .set({ platform, step: 'channel' })
        .where(eq(reportDrafts.userId, user.id))
        .run();

      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
      await api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: `Platform: <b>${platform}</b>\n\n<b>🐛 Step 2/6: Which release channel are you using?</b>`,
        parse_mode: 'HTML',
        reply_markup: releaseChannelKeyboard('chan'),
      });
    } else if (draft.kind === 'extension') {
      await db.update(reportDrafts)
        .set({ platform, step: 'gate' })
        .where(eq(reportDrafts.userId, user.id))
        .run();

      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
      await api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: `Platform: <b>${platform}</b>\n\n<b>⚠️ Important Verification Gate:</b>\n\nDid you test this extension in its original native app (e.g. Mihon, Mangayomi, etc.)?\nDoes it work in the native app and <b>ONLY</b> fail inside AnymeX?`,
        parse_mode: 'HTML',
        reply_markup: nativeAppGateKeyboard(),
      });
    }
    return;
  }

  // 3. Wizard: Release channel selected (Bugs)
  if (data.startsWith('chan:')) {
    const channel = data.split(':')[1];
    await db.update(reportDrafts)
      .set({ releaseChannel: channel, step: 'category' })
      .where(eq(reportDrafts.userId, user.id))
      .run();

    await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
    await api.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text: `Channel: <b>${channel}</b>\n\n<b>🐛 Step 3/6: Which section of the app is having the issue?</b>`,
      parse_mode: 'HTML',
      reply_markup: categoryKeyboard('bug', 'cat'),
    });
    return;
  }

  // 4. Wizard: Category / Source selected
  if (data.startsWith('cat:')) {
    const category = data.split(':')[1];
    const draft = await db.select().from(reportDrafts).where(eq(reportDrafts.userId, user.id)).get();
    if (!draft) return;

    if (draft.kind === 'bug') {
      await db.update(reportDrafts)
        .set({ category, step: 'version' })
        .where(eq(reportDrafts.userId, user.id))
        .run();

      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
      await api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: `Category: <b>${category}</b>\n\n<b>🐛 Step 4/6: What is your AnymeX app version?</b>\n(e.g. <code>3.1.7+39</code>)`,
        parse_mode: 'HTML',
        reply_markup: skipOrCancelKeyboard('skip:version'),
      });
    } else if (draft.kind === 'suggestion') {
      await db.update(reportDrafts)
        .set({ category, step: 'title' })
        .where(eq(reportDrafts.userId, user.id))
        .run();

      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
      await api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: `Category: <b>${category}</b>\n\n<b>💡 Step 2/4: Please send a short, descriptive title for this feature:</b>`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel_wizard' }]],
        },
      });
    } else if (draft.kind === 'extension') {
      await db.update(reportDrafts)
        .set({ category, step: 'platform' })
        .where(eq(reportDrafts.userId, user.id))
        .run();

      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
      await api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: `Source Engine: <b>${category}</b>\n\n<b>🧩 Step 2/5: Select your platform:</b>`,
        parse_mode: 'HTML',
        reply_markup: platformKeyboard('plat'),
      });
    }
    return;
  }

  // 5. Wizard: Extension Native App Gate
  if (data === 'gate:native_ok') {
    await db.update(reportDrafts)
      .set({ testedNativeApp: true, step: 'ext_name' })
      .where(eq(reportDrafts.userId, user.id))
      .run();

    await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
    await api.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text: `<b>🧩 Step 4/5: Send the exact Extension Name and Version:</b>\n(e.g. <code>Gogoanime v1.4.12</code>)`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel_wizard' }]],
      },
    });
    return;
  }

  if (data === 'gate:native_fail') {
    await db.delete(reportDrafts).where(eq(reportDrafts.userId, user.id)).run();
    await api.answerCallbackQuery({
      callback_query_id: callbackQuery.id,
      text: 'Upstream issue. Please report directly to the extension author repository.',
      show_alert: true,
    });
    await api.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text: `⚠️ <b>Notice:</b> Since this extension is also broken in its native app, the issue is with the extension itself rather than AnymeX.\n\nPlease report it directly to the extension repository.`,
      parse_mode: 'HTML',
    });
    return;
  }

  // 6. Wizard: Skip optional steps
  if (data === 'skip:version') {
    await db.update(reportDrafts)
      .set({ appVersion: 'Latest', step: 'title' })
      .where(eq(reportDrafts.userId, user.id))
      .run();

    await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
    await api.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text: `<b>🐛 Step 5/6: Send a short, clear title for this bug:</b>\n(e.g. <i>Video player black screen when switching to 1080p</i>)`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel_wizard' }]],
      },
    });
    return;
  }

  // 7. Wizard: Cancel
  if (data === 'cancel_wizard') {
    await db.delete(reportDrafts).where(eq(reportDrafts.userId, user.id)).run();
    await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'Report cancelled.' });
    await api.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text: '<i>Report submission cancelled. Use /bug or /suggest anytime to start again.</i>',
      parse_mode: 'HTML',
    });
    return;
  }

  // 8. Action: Upvote
  if (data.startsWith('vote:')) {
    const reportId = Number(data.split(':')[1]);
    const res = await toggleVote(reportId, {
      id: user.id,
      username: user.username,
      first_name: user.first_name,
    });

    if (res.ok) {
      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: `Upvoted! Total votes: ${res.votes}` });
      // Update the button counter
      const isWatched = !!(await db.select().from(watchers).where(and(eq(watchers.userId, user.id), eq(watchers.reportId, reportId))).get());
      await api.editMessageReplyMarkup({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: reportCardKeyboard(reportId, res.votes, isWatched),
      });
    } else {
      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: res.error || 'Failed to vote' });
    }
    return;
  }

  // 9. Action: Watch / Unwatch status changes
  if (data.startsWith('watch:')) {
    const reportId = Number(data.split(':')[1]);
    const existing = await db.select().from(watchers).where(and(eq(watchers.userId, user.id), eq(watchers.reportId, reportId))).get();

    if (existing) {
      await db.delete(watchers).where(eq(watchers.id, existing.id)).run();
      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: '🔕 Unwatched. You will no longer receive notifications for this report.' });
      await api.editMessageReplyMarkup({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: reportCardKeyboard(reportId, 0, false),
      });
    } else {
      await db.insert(watchers).values({
        userId: user.id,
        chatId: chatId || user.id,
        reportId,
      }).run();
      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: '🔔 Watched! You will receive DMs when the status changes or devs comment.' });
      await api.editMessageReplyMarkup({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: reportCardKeyboard(reportId, 0, true),
      });
    }
    return;
  }

  // 10. Action: Staff Triage
  if (data.startsWith('triage:')) {
    const [, reportIdStr, newStatus] = data.split(':');
    const reportId = Number(reportIdStr);

    const res = await updateTriageStatus(reportId, newStatus, {
      id: user.id,
      username: user.username,
      first_name: user.first_name,
    });

    if (res.ok) {
      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: `Status updated to ${newStatus}!` });
      await api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: `${message.text}\n\n<b>Updated to:</b> <code>${newStatus}</code> by @${user.username || user.first_name}`,
        parse_mode: 'HTML',
        reply_markup: triageKeyboard(reportId),
      });
    } else {
      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: res.error || 'Failed to update status', show_alert: true });
    }
    return;
  }

  // 11. Action: List reports pagination
  if (data.startsWith('list:bugs:')) {
    const page = Number(data.split(':')[2]) || 1;
    const res = await getReports({ kind: 'bug', state: 'open', page });
    const text = formatReportList(res.data, `🐛 Top Open Bugs (Page ${page})`);

    const buttons = [];
    const navRow = [];
    if (res.meta?.hasPrevPage) navRow.push({ text: '◀️ Prev', callback_data: `list:bugs:${page - 1}` });
    if (res.meta?.hasNextPage) navRow.push({ text: 'Next ▶️', callback_data: `list:bugs:${page + 1}` });
    if (navRow.length > 0) buttons.push(navRow);
    buttons.push([{ text: '➕ Report a Bug', callback_data: 'start:bug' }]);

    await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
    await api.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: buttons },
    });
    return;
  }

  await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
}
