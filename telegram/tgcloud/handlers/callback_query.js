import { api, db } from 'sdk';
import { eq, and } from 'sdk/db';
import { reportDrafts, watchers } from '../schema.js';
import {
  platformKeyboard,
  releaseChannelKeyboard,
  categoryKeyboard,
  versionKeyboard,
  pluginVersionKeyboard,
  nativeAppGateKeyboard,
  cancelKeyboard,
  reportCardKeyboard,
  triageKeyboard,
} from '../lib/keyboards.js';
import {
  getReports,
  getReleases,
  updateTriageStatus,
  toggleVote,
  submitReport,
  uploadAttachment,
} from '../lib/desk_api.js';
import { formatReportList, formatDraftPreview, escapeHtml } from '../lib/formatters.js';
import { safeSendMessage, safeEditMessageText } from '../lib/telegram_helpers.js';
import { BOT_URL, DESK_BASE_URL, CATEGORY_LABELS, PLATFORM_LABELS, RELEASE_CHANNELS } from '../lib/constants.js';

export default async function (callbackQuery) {
  try {
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

    // 1. Wizard: Start a report (Bug, Suggestion, or Extension)
    if (data.startsWith('start:')) {
      const kind = data.split(':')[1]; // 'bug' | 'suggestion' | 'extension'

      // Reset any previous draft
      await db.delete(reportDrafts).where(eq(reportDrafts.userId, user.id)).run();

      let nextPrompt = '';
      let markup;

      if (kind === 'bug') {
        await db.insert(reportDrafts).values({
          userId: user.id,
          kind: 'bug',
          step: 'category',
        }).run();
        nextPrompt = '<b>🐛 Step 1/8: Select Bug Category:</b>\nWhich section of the app is having the issue?';
        markup = categoryKeyboard('bug', 'cat');
      } else if (kind === 'suggestion') {
        await db.insert(reportDrafts).values({
          userId: user.id,
          kind: 'suggestion',
          step: 'category',
        }).run();
        nextPrompt = '<b>💡 Step 1/4: Select Suggestion Category:</b>\nWhich part of AnymeX would this improvement apply to?';
        markup = categoryKeyboard('suggestion', 'cat');
      } else if (kind === 'extension') {
        await db.insert(reportDrafts).values({
          userId: user.id,
          kind: 'extension',
          step: 'category',
        }).run();
        nextPrompt = '<b>🧩 Step 1/11: Extension Source Engine:</b>\nWhich source engine does this extension use?';
        markup = categoryKeyboard('extension', 'cat');
      }

      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
      if (messageId && chatId) {
        await safeEditMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: nextPrompt,
          parse_mode: 'HTML',
          reply_markup: markup,
        });
      }
      return;
    }

    // 2. Wizard: Category / Extension Source selected
    if (data.startsWith('cat:')) {
      const category = data.split(':')[1];
      const draft = await db.select().from(reportDrafts).where(eq(reportDrafts.userId, user.id)).get();
      if (!draft) {
        await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'Session expired. Please restart with /bug or /suggest.' });
        return;
      }

      const catLabel = CATEGORY_LABELS[category] || category;

      if (draft.kind === 'bug') {
        await db.update(reportDrafts)
          .set({ category, step: 'platform' })
          .where(eq(reportDrafts.userId, user.id))
          .run();

        await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
        await safeEditMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: `Category: <b>${catLabel}</b>\n\n<b>🐛 Step 2/8: Select Platform:</b>\nOn which platform does this bug happen?`,
          parse_mode: 'HTML',
          reply_markup: platformKeyboard('', 'plat'),
        });
      } else if (draft.kind === 'suggestion') {
        await db.update(reportDrafts)
          .set({ category, step: 'platform' })
          .where(eq(reportDrafts.userId, user.id))
          .run();

        await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
        await safeEditMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: `Category: <b>${catLabel}</b>\n\n<b>💡 Step 2/4: Target Platform:</b>\nWhich platform is this feature suggestion for?`,
          parse_mode: 'HTML',
          reply_markup: platformKeyboard('', 'plat'),
        });
      } else if (draft.kind === 'extension') {
        await db.update(reportDrafts)
          .set({ category, step: 'platform' })
          .where(eq(reportDrafts.userId, user.id))
          .run();

        await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
        await safeEditMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: `Source Engine: <b>${catLabel}</b>\n\n<b>🧩 Step 2/11: Select Platform:</b>\n<i>(Note: iOS is unavailable for Android-exclusive engines)</i>`,
          parse_mode: 'HTML',
          reply_markup: platformKeyboard(category, 'plat'),
        });
      }
      return;
    }

    // 3. Wizard: Platform selected
    if (data.startsWith('plat:')) {
      const platform = data.split(':')[1];
      const draft = await db.select().from(reportDrafts).where(eq(reportDrafts.userId, user.id)).get();
      if (!draft) {
        await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'Session expired. Please restart.' });
        return;
      }

      const platLabel = PLATFORM_LABELS[platform] || platform;

      if (draft.kind === 'bug') {
        await db.update(reportDrafts)
          .set({ platform, step: 'title' })
          .where(eq(reportDrafts.userId, user.id))
          .run();

        await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
        await safeEditMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: `Platform: <b>${platLabel}</b>\n\n<b>🐛 Step 3/8: Bug Title</b>\nBriefly describe what went wrong (at least 5 characters):\n(e.g. <i>Video freezes when switching to 1080p stream</i>)`,
          parse_mode: 'HTML',
          reply_markup: cancelKeyboard(),
        });
      } else if (draft.kind === 'suggestion') {
        await db.update(reportDrafts)
          .set({ platform, step: 'title' })
          .where(eq(reportDrafts.userId, user.id))
          .run();

        await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
        await safeEditMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: `Platform: <b>${platLabel}</b>\n\n<b>💡 Step 3/4: Suggestion Title</b>\nWhat feature or improvement would you like to see? (at least 5 characters):\n(e.g. <i>Add auto-skip intro button in video player</i>)`,
          parse_mode: 'HTML',
          reply_markup: cancelKeyboard(),
        });
      } else if (draft.kind === 'extension') {
        await db.update(reportDrafts)
          .set({ platform, step: 'gate' })
          .where(eq(reportDrafts.userId, user.id))
          .run();

        await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
        await safeEditMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: `Platform: <b>${platLabel}</b>\n\n<b>⚠️ Step 3/11: Native App Verification Gate</b>\n\nOnly report an extension issue if the extension works correctly in its dedicated app (e.g. Mihon, Mangayomi, etc.) but does <b>NOT</b> work in AnymeX.\n\nDid you test it in the native app and confirm the issue only occurs in AnymeX?`,
          parse_mode: 'HTML',
          reply_markup: nativeAppGateKeyboard(),
        });
      }
      return;
    }

    // 4. Wizard: Extension Native App Gate
    if (data === 'gate:native_ok') {
      await db.update(reportDrafts)
        .set({ testedNativeApp: true, step: 'title' })
        .where(eq(reportDrafts.userId, user.id))
        .run();

      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
      await safeEditMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: `<b>🧩 Step 4/11: Title</b>\nGive a short summary of the issue (at least 5 characters):\n(e.g. <i>Gogoanime fails to load chapter list</i>)`,
        parse_mode: 'HTML',
        reply_markup: cancelKeyboard(),
      });
      return;
    }

    if (data === 'gate:native_fail') {
      await db.delete(reportDrafts).where(eq(reportDrafts.userId, user.id)).run();
      await api.answerCallbackQuery({
        callback_query_id: callbackQuery.id,
        text: 'Issue with extension itself. Please report to the extension repository.',
        show_alert: true,
      });
      await safeEditMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: `⚠️ <b>Notice:</b> Since this extension also fails in its native app, the issue is upstream with the extension source rather than AnymeX.\n\nPlease report it directly to the extension author repository.`,
        parse_mode: 'HTML',
      });
      return;
    }

    // 5. Wizard: Release channel selected (Bug & Extension)
    if (data.startsWith('chan:')) {
      const channel = data.split(':')[1];
      const draft = await db.select().from(reportDrafts).where(eq(reportDrafts.userId, user.id)).get();
      if (!draft) return;

      const releases = await getReleases();

      if (draft.kind === 'bug') {
        await db.update(reportDrafts)
          .set({ releaseChannel: channel, step: 'version' })
          .where(eq(reportDrafts.userId, user.id))
          .run();

        await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
        await safeEditMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: `Channel: <b>${channel === 'beta' ? '🧪 Beta (Preview)' : '🟢 Stable'}</b>\n\n<b>🐛 Step 5/8: App Version (Required)</b>\nSelect your version from <b>Settings → About</b> in AnymeX:`,
          parse_mode: 'HTML',
          reply_markup: versionKeyboard(channel, releases, 'ver'),
        });
      } else if (draft.kind === 'extension') {
        await db.update(reportDrafts)
          .set({ releaseChannel: channel, step: 'version' })
          .where(eq(reportDrafts.userId, user.id))
          .run();

        await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
        await safeEditMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: `Channel: <b>${channel === 'beta' ? '🧪 Beta (Preview)' : '🟢 Stable'}</b>\n\n<b>🧩 Step 6/11: App Version (Required)</b>\nSelect your version from <b>Settings → About</b> in AnymeX:`,
          parse_mode: 'HTML',
          reply_markup: versionKeyboard(channel, releases, 'ver'),
        });
      }
      return;
    }

    // 6. Wizard: App Version selected via button (Bug & Extension)
    if (data.startsWith('ver:')) {
      const selectedVer = data.split(':')[1];
      const draft = await db.select().from(reportDrafts).where(eq(reportDrafts.userId, user.id)).get();
      if (!draft) {
        await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'Session expired.' });
        return;
      }

      if (selectedVer === 'custom') {
        await db.update(reportDrafts)
          .set({ step: 'version_custom' })
          .where(eq(reportDrafts.userId, user.id))
          .run();

        await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
        await safeEditMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: `<b>Custom App Version (Required)</b>\nPlease type and send your exact AnymeX version (e.g. <code>3.1.7</code> or git commit):`,
          parse_mode: 'HTML',
          reply_markup: cancelKeyboard(),
        });
        return;
      }

      await db.update(reportDrafts)
        .set({ appVersion: selectedVer })
        .where(eq(reportDrafts.userId, user.id))
        .run();

      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: `Version: ${selectedVer}` });

      if (draft.kind === 'bug') {
        await db.update(reportDrafts)
          .set({ step: 'body' })
          .where(eq(reportDrafts.userId, user.id))
          .run();

        await safeEditMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: `Version: <code>${selectedVer}</code>\n\n<b>🐛 Step 6/8: Description & Expected Behavior (Required)</b>\nPlease describe what actually happened and what you expected to happen instead:`,
          parse_mode: 'HTML',
          reply_markup: cancelKeyboard(),
        });
      } else if (draft.kind === 'extension') {
        if (draft.platform === 'ios') {
          // iOS does not use extension runtime bridge plugin
          await db.update(reportDrafts)
            .set({ step: 'ext_name' })
            .where(eq(reportDrafts.userId, user.id))
            .run();

          await safeEditMessageText({
            chat_id: chatId,
            message_id: messageId,
            text: `Version: <code>${selectedVer}</code>\n\n<i>(iOS does not use the extension runtime bridge plugin)</i>\n\n<b>🧩 Step 8/11: Affected Extension Name & Version (Required)</b>\nSend the exact extension name and version (e.g. <code>Gogoanime v1.4.12</code>):`,
            parse_mode: 'HTML',
            reply_markup: cancelKeyboard(),
          });
        } else {
          // Ask for Extension Runtime Bridge plugin version
          const releases = await getReleases();
          await db.update(reportDrafts)
            .set({ step: 'plugin_version' })
            .where(eq(reportDrafts.userId, user.id))
            .run();

          await safeEditMessageText({
            chat_id: chatId,
            message_id: messageId,
            text: `Version: <code>${selectedVer}</code>\n\n<b>🧩 Step 7/11: Extension Runtime Bridge (Plugin) Version (Required)</b>\nCheck <b>Settings → Extensions → Settings icon (gear) on top right</b>:`,
            parse_mode: 'HTML',
            reply_markup: pluginVersionKeyboard(releases, 'pver'),
          });
        }
      }
      return;
    }

    // 7. Wizard: Plugin Version selected via button (Extension)
    if (data.startsWith('pver:')) {
      const selectedPver = data.split(':')[1];
      const draft = await db.select().from(reportDrafts).where(eq(reportDrafts.userId, user.id)).get();
      if (!draft) return;

      if (selectedPver === 'custom') {
        await db.update(reportDrafts)
          .set({ step: 'plugin_version_custom' })
          .where(eq(reportDrafts.userId, user.id))
          .run();

        await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
        await safeEditMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: `<b>Custom Plugin Version (Required)</b>\nPlease type and send your exact Plugin Bridge version (e.g. <code>2.4.0</code>):`,
          parse_mode: 'HTML',
          reply_markup: cancelKeyboard(),
        });
        return;
      }

      await db.update(reportDrafts)
        .set({ pluginVersion: selectedPver, step: 'ext_name' })
        .where(eq(reportDrafts.userId, user.id))
        .run();

      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: `Plugin: ${selectedPver}` });
      await safeEditMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: `Plugin Version: <code>${selectedPver}</code>\n\n<b>🧩 Step 8/11: Affected Extension Name & Version (Required)</b>\nSend the exact extension name and version (e.g. <code>Gogoanime v1.4.12</code>):`,
        parse_mode: 'HTML',
        reply_markup: cancelKeyboard(),
      });
      return;
    }

    // 8. Wizard: Cancel
    if (data === 'cancel_wizard') {
      await db.delete(reportDrafts).where(eq(reportDrafts.userId, user.id)).run();
      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'Report cancelled.' });
      await safeEditMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: '<i>Report submission cancelled. Use /bug, /suggest, or /ext anytime to start again.</i>',
        parse_mode: 'HTML',
      });
      return;
    }

    // 9. Wizard: Submit Report Now (Final confirmation button)
    if (data === 'submit_now') {
      const draft = await db.select().from(reportDrafts).where(eq(reportDrafts.userId, user.id)).get();
      if (!draft) {
        await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'No active draft found.' });
        return;
      }

      // Validate required fields exactly as website requires
      let parsedAttachments = [];
      try {
        if (draft.attachments) parsedAttachments = JSON.parse(draft.attachments);
      } catch {}

      if (draft.kind === 'bug') {
        if (!draft.appVersion) {
          await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'App version is required.', show_alert: true });
          return;
        }
        if (!draft.body) {
          await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'Description is required.', show_alert: true });
          return;
        }
        if (!draft.stepsToReproduce) {
          await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'Steps to reproduce are required.', show_alert: true });
          return;
        }
        if (parsedAttachments.length < 1) {
          await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'At least one attachment (screenshot, recording, or log) is required.', show_alert: true });
          return;
        }
      } else if (draft.kind === 'extension') {
        if (!draft.appVersion) {
          await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'App version is required.', show_alert: true });
          return;
        }
        if (draft.platform !== 'ios' && !draft.pluginVersion) {
          await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'Extension Runtime Bridge plugin version is required.', show_alert: true });
          return;
        }
        if (!draft.extensionRepo) {
          await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'Extension repository URL is required.', show_alert: true });
          return;
        }
        if (parsedAttachments.length < 1) {
          await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'At least one comparison attachment is required.', show_alert: true });
          return;
        }
      } else if (draft.kind === 'suggestion') {
        if (!draft.title || draft.title.length < 5) {
          await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'Title must be at least 5 characters.', show_alert: true });
          return;
        }
        if (!draft.body) {
          await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'Suggestion details are required.', show_alert: true });
          return;
        }
      }

      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: 'Submitting report to Desk...' });

      const payload = {
        kind: draft.kind,
        category: draft.category || 'other',
        platform: draft.platform || 'all',
        releaseChannel: draft.releaseChannel || 'stable',
        appVersion: draft.appVersion || null,
        pluginVersion: draft.pluginVersion || null,
        title: draft.title,
        body: draft.body || draft.stepsToReproduce || '',
        stepsToReproduce: draft.stepsToReproduce || null,
        testedNativeApp: Boolean(draft.testedNativeApp),
        extensionNames: draft.extensionNames || null,
        extensionRepo: draft.extensionRepo || null,
        telegramUser: {
          id: user.id,
          username: user.username,
          first_name: user.first_name,
        },
      };

      const result = await submitReport(payload);

      if (result.ok) {
        // Upload any attached media or documents to Desk
        let uploadedCount = 0;
        if (parsedAttachments && parsedAttachments.length > 0) {
          for (const att of parsedAttachments) {
            if (att.file_id) {
              try {
                const bytes = await api.getFileContent(att.file_id);
                if (bytes) {
                  const up = await uploadAttachment(
                    result.reportId,
                    bytes,
                    att.file_name,
                    att.type,
                    user.username || user.first_name || 'Telegram User'
                  );
                  if (up && up.ok) uploadedCount++;
                }
              } catch (attErr) {
                console.error(`Failed to upload attachment ${att.file_id}:`, attErr);
              }
            }
          }
        }

        // Auto-watch this report
        await db.insert(watchers).values({
          userId: user.id,
          chatId,
          reportId: result.reportId,
        }).run();

        await db.delete(reportDrafts).where(eq(reportDrafts.userId, user.id)).run();

        const successMsg = `🎉 <b>${draft.kind === 'suggestion' ? 'Suggestion' : 'Report'} #${result.reportId} Filed Successfully!</b>\n\n` +
          `📌 <b>Title:</b> ${escapeHtml(payload.title)}\n` +
          `📱 <b>Platform:</b> ${payload.platform}  •  🏷 <b>Category:</b> ${CATEGORY_LABELS[payload.category] || payload.category}\n` +
          (uploadedCount > 0 ? `📎 <b>Attachments:</b> ${uploadedCount} file(s) attached\n` : '') +
          `🌐 <b>Desk URL:</b> <a href="${DESK_BASE_URL}/report/${result.reportId}">View Report on Desk</a>\n\n` +
          `🔔 <i>You are now watching this ticket! We'll send you a Telegram DM when maintainers update the status or comment.</i>`;

        await safeEditMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: successMsg,
          parse_mode: 'HTML',
          reply_markup: reportCardKeyboard(result.reportId, 1, true),
        });
      } else {
        await safeSendMessage({
          chat_id: chatId,
          text: `❌ <b>Submission Error:</b> ${escapeHtml(result.error || 'Failed to submit report. Please try again.')}`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Retry Submit', callback_data: 'submit_now' }],
              [{ text: '❌ Cancel', callback_data: 'cancel_wizard' }],
            ],
          },
        });
      }
      return;
    }

    // 10. Action: Upvote
    if (data.startsWith('vote:')) {
      const reportId = Number(data.split(':')[1]);
      const res = await toggleVote(reportId, {
        id: user.id,
        username: user.username,
        first_name: user.first_name,
      });

      if (res.ok) {
        await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: `Upvoted! Total votes: ${res.votes}` });
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

    // 11. Action: Watch / Unwatch status changes
    if (data.startsWith('watch:')) {
      const reportId = Number(data.split(':')[1]);
      const existing = await db.select().from(watchers).where(and(eq(watchers.userId, user.id), eq(watchers.reportId, reportId))).get();

      if (existing) {
        await db.delete(watchers).where(eq(watchers.id, existing.id)).run();
        await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: '🔕 Unwatched.' });
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
        await api.answerCallbackQuery({ callback_query_id: callbackQuery.id, text: '🔔 Watched! You will receive DMs when the status changes.' });
        await api.editMessageReplyMarkup({
          chat_id: chatId,
          message_id: messageId,
          reply_markup: reportCardKeyboard(reportId, 0, true),
        });
      }
      return;
    }

    // 12. Action: Staff Triage
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
        await safeEditMessageText({
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

    // 13a. Action: List suggestions pagination
    if (data.startsWith('list:suggestions:')) {
      const page = Number(data.split(':')[2]) || 1;
      const res = await getReports({ kind: 'suggestion', state: 'open', page });
      const text = formatReportList(res.data, '💡 Top Suggestions', page, 6);

      const buttons = [];
      const navRow = [];
      if (page > 1) navRow.push({ text: '◀️ Prev', callback_data: `list:suggestions:${page - 1}` });
      if (res.data && res.data.length > page * 6) navRow.push({ text: 'Next ▶️', callback_data: `list:suggestions:${page + 1}` });
      if (navRow.length > 0) buttons.push(navRow);
      buttons.push([
        isGroup
          ? { text: '💡 Propose Feature in DM', url: `${BOT_URL}?start=suggestion` }
          : { text: '💡 Propose Feature', callback_data: 'start:suggestion' }
      ]);

      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
      await safeEditMessageText({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons },
      });
      return;
    }

    // 13b. Action: List bugs pagination
    if (data.startsWith('list:bugs:')) {
      const page = Number(data.split(':')[2]) || 1;
      const res = await getReports({ kind: 'bug', state: 'open', page });
      const text = formatReportList(res.data, '🐛 Top Open Bugs', page, 6);

      const buttons = [];
      const navRow = [];
      if (page > 1) navRow.push({ text: '◀️ Prev', callback_data: `list:bugs:${page - 1}` });
      if (res.data && res.data.length > page * 6) navRow.push({ text: 'Next ▶️', callback_data: `list:bugs:${page + 1}` });
      if (navRow.length > 0) buttons.push(navRow);
      buttons.push([
        isGroup
          ? { text: '🐛 Report a Bug in DM', url: `${BOT_URL}?start=bug` }
          : { text: '➕ Report a Bug', callback_data: 'start:bug' }
      ]);

      await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
      await safeEditMessageText({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: buttons },
      });
      return;
    }

    await api.answerCallbackQuery({ callback_query_id: callbackQuery.id });
  } catch (err) {
    console.error('handlers/callback_query error:', err);
    try {
      await api.answerCallbackQuery({
        callback_query_id: callbackQuery.id,
        text: `Error: ${err.message || 'Operation failed'}`,
        show_alert: true,
      });
    } catch {}
  }
}
