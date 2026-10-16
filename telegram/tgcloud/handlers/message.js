import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import { reportDrafts, watchers } from '../schema.js';
import {
  mainMenuKeyboard,
  reportCardKeyboard,
  categoryKeyboard,
  platformKeyboard,
  releaseChannelKeyboard,
  versionKeyboard,
  pluginVersionKeyboard,
  cancelKeyboard,
} from '../lib/keyboards.js';
import {
  getReports,
  getReportDetails,
  getReleases,
  searchSimilar,
  submitReport,
} from '../lib/desk_api.js';
import { formatReportList, formatReportCard, formatDraftPreview, escapeHtml } from '../lib/formatters.js';
import { safeSendMessage } from '../lib/telegram_helpers.js';
import { DESK_BASE_URL, BOT_URL, CATEGORY_LABELS, PLATFORM_LABELS } from '../lib/constants.js';

export default async function (message) {
  try {
    const chatId = message?.chat?.id;
    const userId = message?.from?.id;
    const user = message?.from;
    if (!chatId || !userId) return;

    const rawText = (message.text || message.caption || '').trim();
    // Strip bot mention if command was sent in a group (e.g. /bugs@AnymeXDeskBot -> /bugs)
    const text = rawText.replace(/^(\/[a-zA-Z0-9_]+)@\w+bot\b/i, '$1');
    const isGroup = message.chat.type === 'group' || message.chat.type === 'supergroup';

    const photo = message.photo && message.photo.length > 0 ? message.photo[message.photo.length - 1] : null;
    const video = message.video || null;
    const document = message.document || null;
    const animation = message.animation || null;
    const audio = message.audio || null;
    const hasMedia = !!(photo || video || document || animation || audio);

    // In groups, ignore any message that is not a slash command
    if (isGroup && !text.startsWith('/')) {
      return;
    }

    // In groups, redirect report creation commands directly to private DM
    const isBugCmd = text === '/bug' || text.startsWith('/bug ');
    const isSuggestCmd = text === '/suggest' || text.startsWith('/suggest ');
    const isExtCmd = text === '/ext' || text.startsWith('/ext ') || text === '/extension';

    if (isGroup && (isBugCmd || isSuggestCmd || isExtCmd)) {
      const kind = isSuggestCmd ? 'suggestion' : (isExtCmd ? 'extension' : 'bug');
      const label = isSuggestCmd ? '💡 Propose Feature in Private DM' : (isExtCmd ? '🧩 Report Extension Issue in DM' : '🐛 File Bug Report in Private DM');
      await safeSendMessage({
        chat_id: chatId,
        reply_to_message_id: message.message_id,
        text: `💡 <b>To keep this group chat clean, reports are filed in private chat:</b>`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: label, url: `${BOT_URL}?start=${kind}` }],
          ],
        },
      });
      return;
    }

    // 1. Slash Commands
    if (text.startsWith('/start') || text.startsWith('/help')) {
      const param = text.split(' ')[1] || '';
      await db.delete(reportDrafts).where(eq(reportDrafts.userId, userId)).run();

      // Register the slash command popup menu in Telegram
      const commands = [
        { command: 'start', description: 'Open main menu and instructions' },
        { command: 'bugs', description: 'View top open bug reports' },
        { command: 'suggestions', description: 'View feature requests' },
        { command: 'report', description: 'View report details (/report <id>)' },
        { command: 'bug', description: 'File a new bug report' },
        { command: 'suggest', description: 'Propose a new feature' },
        { command: 'ext', description: 'Report an extension issue' },
        { command: 'cancel', description: 'Cancel current report wizard' },
      ];
      await api.setMyCommands({ commands, scope: { type: 'default' } }).catch(() => {});
      await api.setMyCommands({ commands, scope: { type: 'all_private_chats' } }).catch(() => {});
      await api.setMyCommands({ commands, scope: { type: 'all_group_chats' } }).catch(() => {});
      await api.setChatMenuButton({ menu_button: { type: 'commands' } }).catch(() => {});

      // Handle deep-link redirects from group chat or web
      if (param === 'bug') {
        await db.insert(reportDrafts).values({ userId, kind: 'bug', step: 'category' }).run();
        await safeSendMessage({
          chat_id: chatId,
          text: '<b>🐛 Step 1/8: Select Bug Category:</b>\nWhich section of the app is having the issue?',
          parse_mode: 'HTML',
          reply_markup: categoryKeyboard('bug', 'cat'),
        });
        return;
      }

      if (param === 'suggestion') {
        await db.insert(reportDrafts).values({ userId, kind: 'suggestion', step: 'category' }).run();
        await safeSendMessage({
          chat_id: chatId,
          text: '<b>💡 Step 1/4: Select Suggestion Category:</b>\nWhich part of AnymeX would this improvement apply to?',
          parse_mode: 'HTML',
          reply_markup: categoryKeyboard('suggestion', 'cat'),
        });
        return;
      }

      if (param === 'extension' || param === 'ext') {
        await db.insert(reportDrafts).values({ userId, kind: 'extension', step: 'category' }).run();
        await safeSendMessage({
          chat_id: chatId,
          text: '<b>🧩 Step 1/11: Extension Source Engine:</b>\nWhich source engine does this extension use?',
          parse_mode: 'HTML',
          reply_markup: categoryKeyboard('extension', 'cat'),
        });
        return;
      }

      const welcome = `<b>👋 Welcome to AnymeX Desk Bot!</b>\n\n` +
        `This bot lets you search, track, and report bugs or feature suggestions for the <b>AnymeX</b> app directly inside Telegram.\n\n` +
        `<b>Available Commands:</b>\n` +
        `• /bugs — View top open bugs\n` +
        `• /suggestions — View feature requests\n` +
        `• /report <code>&lt;id&gt;</code> — View ticket details & status\n` +
        `• /bug — File a new bug report\n` +
        `• /suggest — Propose a new feature\n` +
        `• /ext — Report an extension issue\n` +
        `• /cancel — Cancel current report wizard\n\n` +
        `<i>Tip: You can also type <code>@AnymeXDeskBot player lag</code> in any chat to search tickets inline!</i>`;

      await safeSendMessage({
        chat_id: chatId,
        text: welcome,
        parse_mode: 'HTML',
        reply_markup: mainMenuKeyboard(isGroup),
      });
      return;
    }

    if (text === '/cancel') {
      await db.delete(reportDrafts).where(eq(reportDrafts.userId, userId)).run();
      await safeSendMessage({
        chat_id: chatId,
        text: '<i>Report creation cancelled. Use /bug, /suggest, or /ext whenever you are ready.</i>',
        parse_mode: 'HTML',
        reply_markup: mainMenuKeyboard(isGroup),
      });
      return;
    }

    if (text === '/bugs') {
      const res = await getReports({ kind: 'bug', state: 'open', page: 1 });
      const listText = formatReportList(res.data, '🐛 Top Open Bugs', 1, 6);
      await safeSendMessage({
        chat_id: chatId,
        text: listText,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              isGroup
                ? { text: '➕ Report a Bug in DM', url: `${BOT_URL}?start=bug` }
                : { text: '➕ Report a Bug', callback_data: 'start:bug' },
              { text: '🔍 Search', switch_inline_query_current_chat: '' },
            ],
            res.data && res.data.length > 6
              ? [{ text: 'Next ▶️', callback_data: 'list:bugs:2' }]
              : [],
          ].filter((row) => row.length > 0),
        },
      });
      return;
    }

    if (text === '/suggestions') {
      const res = await getReports({ kind: 'suggestion', state: 'open', page: 1 });
      const listText = formatReportList(res.data, '💡 Top Suggestions', 1, 6);
      await safeSendMessage({
        chat_id: chatId,
        text: listText,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              isGroup
                ? { text: '💡 Propose Feature in DM', url: `${BOT_URL}?start=suggestion` }
                : { text: '💡 Propose Feature', callback_data: 'start:suggestion' },
              { text: '🔍 Search', switch_inline_query_current_chat: '' },
            ],
            res.data && res.data.length > 6
              ? [{ text: 'Next ▶️', callback_data: 'list:suggestions:2' }]
              : [],
          ].filter((row) => row.length > 0),
        },
      });
      return;
    }

    if (text.startsWith('/report')) {
      const parts = text.split(' ');
      const id = Number(parts[1]);
      if (!id || isNaN(id)) {
        await safeSendMessage({
          chat_id: chatId,
          text: 'Usage: <code>/report &lt;id&gt;</code> (e.g. <code>/report 42</code>)',
          parse_mode: 'HTML',
        });
        return;
      }

      const report = await getReportDetails(id);
      if (!report) {
        await safeSendMessage({
          chat_id: chatId,
          text: `❌ Report <b>#${id}</b> not found on AnymeX Desk.`,
          parse_mode: 'HTML',
        });
        return;
      }

      const isWatched = !!(await db.select().from(watchers).where(eq(watchers.userId, userId)).get());
      const card = formatReportCard(report);
      await safeSendMessage({
        chat_id: chatId,
        text: card,
        parse_mode: 'HTML',
        reply_markup: reportCardKeyboard(report.id, report.votes || 0, isWatched),
      });
      return;
    }

    if (text === '/bug') {
      await db.delete(reportDrafts).where(eq(reportDrafts.userId, userId)).run();
      await db.insert(reportDrafts).values({
        userId,
        kind: 'bug',
        step: 'category',
      }).run();

      await safeSendMessage({
        chat_id: chatId,
        text: '<b>🐛 Step 1/8: Select Bug Category:</b>\nWhich section of the app is having the issue?',
        parse_mode: 'HTML',
        reply_markup: categoryKeyboard('bug', 'cat'),
      });
      return;
    }

    if (text === '/suggest') {
      await db.delete(reportDrafts).where(eq(reportDrafts.userId, userId)).run();
      await db.insert(reportDrafts).values({
        userId,
        kind: 'suggestion',
        step: 'category',
      }).run();

      await safeSendMessage({
        chat_id: chatId,
        text: '<b>💡 Step 1/4: Select Suggestion Category:</b>\nWhich part of AnymeX would this improvement apply to?',
        parse_mode: 'HTML',
        reply_markup: categoryKeyboard('suggestion', 'cat'),
      });
      return;
    }

    if (text === '/ext' || text === '/extension') {
      await db.delete(reportDrafts).where(eq(reportDrafts.userId, userId)).run();
      await db.insert(reportDrafts).values({
        userId,
        kind: 'extension',
        step: 'category',
      }).run();

      await safeSendMessage({
        chat_id: chatId,
        text: '<b>🧩 Step 1/11: Extension Source Engine:</b>\nWhich source engine does this extension use?',
        parse_mode: 'HTML',
        reply_markup: categoryKeyboard('extension', 'cat'),
      });
      return;
    }

    // 2. Active Wizard Text & Media Input
    const draft = await db.select().from(reportDrafts).where(eq(reportDrafts.userId, userId)).get();
    if (!draft) {
      // Only respond if the user in DM explicitly typed an unknown slash command
      if (!isGroup && text.startsWith('/')) {
        await safeSendMessage({
          chat_id: chatId,
          text: `<i>Unknown command. Type /help to see available commands.</i>`,
          parse_mode: 'HTML',
        });
      }
      return;
    }

    // Wizard Step: Custom App Version
    if (draft.step === 'version_custom') {
      const ver = text.slice(0, 32);
      if (!ver) {
        await safeSendMessage({
          chat_id: chatId,
          text: '⚠️ Please enter your AnymeX version (e.g. <code>3.1.7</code>):',
          parse_mode: 'HTML',
        });
        return;
      }

      await db.update(reportDrafts)
        .set({ appVersion: ver })
        .where(eq(reportDrafts.userId, userId))
        .run();

      if (draft.kind === 'bug') {
        await db.update(reportDrafts).set({ step: 'body' }).where(eq(reportDrafts.userId, userId)).run();
        await safeSendMessage({
          chat_id: chatId,
          text: `Version set to: <code>${escapeHtml(ver)}</code>\n\n<b>🐛 Step 6/8: Description & Expected Behavior (Required)</b>\nWhat happened? What did you expect to happen instead?`,
          parse_mode: 'HTML',
          reply_markup: cancelKeyboard(),
        });
      } else if (draft.kind === 'extension') {
        if (draft.platform === 'ios') {
          await db.update(reportDrafts).set({ step: 'ext_name' }).where(eq(reportDrafts.userId, userId)).run();
          await safeSendMessage({
            chat_id: chatId,
            text: `Version set to: <code>${escapeHtml(ver)}</code>\n\n<i>(iOS does not use the extension runtime bridge plugin)</i>\n\n<b>🧩 Step 8/11: Affected Extension Name & Version (Required)</b>\nSend the exact extension name and version (e.g. <code>Gogoanime v1.4.12</code>):`,
            parse_mode: 'HTML',
            reply_markup: cancelKeyboard(),
          });
        } else {
          const releases = await getReleases();
          await db.update(reportDrafts).set({ step: 'plugin_version' }).where(eq(reportDrafts.userId, userId)).run();
          await safeSendMessage({
            chat_id: chatId,
            text: `Version set to: <code>${escapeHtml(ver)}</code>\n\n<b>🧩 Step 7/11: Extension Runtime Bridge (Plugin) Version (Required)</b>\nCheck <b>Settings → Extensions → Settings icon (gear) on top right</b>:`,
            parse_mode: 'HTML',
            reply_markup: pluginVersionKeyboard(releases, 'pver'),
          });
        }
      }
      return;
    }

    // Wizard Step: Custom Plugin Version (Extension)
    if (draft.step === 'plugin_version_custom') {
      const pver = text.slice(0, 32);
      if (!pver) {
        await safeSendMessage({
          chat_id: chatId,
          text: '⚠️ Please enter your Plugin Bridge version (e.g. <code>2.4.0</code>):',
          parse_mode: 'HTML',
        });
        return;
      }

      await db.update(reportDrafts)
        .set({ pluginVersion: pver, step: 'ext_name' })
        .where(eq(reportDrafts.userId, userId))
        .run();

      await safeSendMessage({
        chat_id: chatId,
        text: `Plugin version set to: <code>${escapeHtml(pver)}</code>\n\n<b>🧩 Step 8/11: Affected Extension Name & Version (Required)</b>\nSend the exact extension name and version (e.g. <code>Gogoanime v1.4.12</code>):`,
        parse_mode: 'HTML',
        reply_markup: cancelKeyboard(),
      });
      return;
    }

    // Wizard Step: Title
    if (draft.step === 'title') {
      const title = text.slice(0, 200);
      if (!title || title.length < 5) {
        await safeSendMessage({
          chat_id: chatId,
          text: '⚠️ Title must be at least 5 characters. Please send a descriptive title:',
          parse_mode: 'HTML',
        });
        return;
      }

      // Check similarity advisory (non-blocking)
      try {
        const similar = await searchSimilar(title, draft.kind);
        if (similar.length > 0) {
          const topHit = similar[0];
          await safeSendMessage({
            chat_id: chatId,
            text: `⚠️ <b>Similar report already found on Desk!</b>\n\n` +
              `<b>#${topHit.id}: ${escapeHtml(topHit.title)}</b>\n` +
              `Status: <code>${topHit.status}</code>  •  ▲ ${topHit.votes || 0} votes\n\n` +
              `Instead of filing a duplicate, you can upvote the existing ticket below!`,
            parse_mode: 'HTML',
            reply_markup: reportCardKeyboard(topHit.id, topHit.votes || 0, false),
          }).catch(() => {});
        }
      } catch {}

      if (draft.kind === 'bug') {
        await db.update(reportDrafts)
          .set({ title, step: 'channel' })
          .where(eq(reportDrafts.userId, userId))
          .run();

        await safeSendMessage({
          chat_id: chatId,
          text: `Title: <b>${escapeHtml(title)}</b>\n\n<b>🐛 Step 4/8: Release Channel</b>\nSelect whether you encountered this issue on the official stable release or the preview beta:`,
          parse_mode: 'HTML',
          reply_markup: releaseChannelKeyboard('chan'),
        });
      } else if (draft.kind === 'suggestion') {
        await db.update(reportDrafts)
          .set({ title, step: 'body' })
          .where(eq(reportDrafts.userId, userId))
          .run();

        await safeSendMessage({
          chat_id: chatId,
          text: `Title: <b>${escapeHtml(title)}</b>\n\n<b>💡 Step 4/4: Suggestion Details (Required)</b>\nDescribe your idea in detail:\n• Why is this needed?\n• How should it work?\n• What makes it useful?`,
          parse_mode: 'HTML',
          reply_markup: cancelKeyboard(),
        });
      } else if (draft.kind === 'extension') {
        await db.update(reportDrafts)
          .set({ title, step: 'channel' })
          .where(eq(reportDrafts.userId, userId))
          .run();

        await safeSendMessage({
          chat_id: chatId,
          text: `Title: <b>${escapeHtml(title)}</b>\n\n<b>🧩 Step 5/11: Release Channel</b>\nSelect whether you encountered this on stable or beta:`,
          parse_mode: 'HTML',
          reply_markup: releaseChannelKeyboard('chan'),
        });
      }
      return;
    }

    // Wizard Step: Bug Description
    if (draft.kind === 'bug' && draft.step === 'body') {
      const desc = text.slice(0, 5000);
      if (!desc) {
        await safeSendMessage({
          chat_id: chatId,
          text: '⚠️ Description is required. What happened? What did you expect to happen instead?',
          parse_mode: 'HTML',
        });
        return;
      }

      await db.update(reportDrafts)
        .set({ body: desc, step: 'steps' })
        .where(eq(reportDrafts.userId, userId))
        .run();

      await safeSendMessage({
        chat_id: chatId,
        text: `<b>🐛 Step 7/8: Steps to Reproduce (Required)</b>\nDescribe step-by-step how to reproduce the bug:\n1. Open the app\n2. Go to...\n3. Tap on...`,
        parse_mode: 'HTML',
        reply_markup: cancelKeyboard(),
      });
      return;
    }

    // Wizard Step: Bug Steps to Reproduce
    if (draft.kind === 'bug' && draft.step === 'steps') {
      const steps = text.slice(0, 5000);
      if (!steps) {
        await safeSendMessage({
          chat_id: chatId,
          text: '⚠️ Steps to reproduce are required for bug reports. Please provide steps to trigger the bug:',
          parse_mode: 'HTML',
        });
        return;
      }

      await db.update(reportDrafts)
        .set({ stepsToReproduce: steps, step: 'attachments' })
        .where(eq(reportDrafts.userId, userId))
        .run();

      await safeSendMessage({
        chat_id: chatId,
        text: `<b>📎 Step 8/8: Attachments (Required)</b>\nAt least 1 attachment (screenshot, recording, or log file) is required to demonstrate the bug.\n\n<i>Please send a photo, video, or file now:</i>`,
        parse_mode: 'HTML',
        reply_markup: cancelKeyboard(),
      });
      return;
    }

    // Wizard Step: Suggestion Details -> Review Card
    if (draft.kind === 'suggestion' && draft.step === 'body') {
      const bodyText = text.slice(0, 5000);
      if (!bodyText) {
        await safeSendMessage({
          chat_id: chatId,
          text: '⚠️ Please describe your suggestion.',
          parse_mode: 'HTML',
        });
        return;
      }

      await db.update(reportDrafts)
        .set({ body: bodyText, step: 'review' })
        .where(eq(reportDrafts.userId, userId))
        .run();

      const updated = await db.select().from(reportDrafts).where(eq(reportDrafts.userId, userId)).get();

      await safeSendMessage({
        chat_id: chatId,
        text: formatDraftPreview(updated) + `\n\n<i>Note: Attachments are optional for suggestions. You can attach mockups or screenshots now, or tap Submit directly:</i>`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Confirm & Submit Suggestion', callback_data: 'submit_now' }],
            [{ text: '❌ Cancel', callback_data: 'cancel_wizard' }],
          ],
        },
      });
      return;
    }

    // Wizard Step: Extension Name & Version
    if (draft.kind === 'extension' && draft.step === 'ext_name') {
      const extInfo = text.slice(0, 200);
      if (!extInfo) {
        await safeSendMessage({
          chat_id: chatId,
          text: '⚠️ Extension name and version are required (e.g. <code>Gogoanime v1.4.12</code>):',
          parse_mode: 'HTML',
        });
        return;
      }

      await db.update(reportDrafts)
        .set({
          extensionNames: JSON.stringify([{ name: extInfo, version: '1.0', issue: '' }]),
          step: 'ext_issue',
        })
        .where(eq(reportDrafts.userId, userId))
        .run();

      await safeSendMessage({
        chat_id: chatId,
        text: `Extension: <b>${escapeHtml(extInfo)}</b>\n\n<b>🧩 Step 9/11: What is wrong with this extension? (Required)</b>\nDescribe what specifically fails inside AnymeX (e.g. <i>Video player returns 403 error, search fails</i>):`,
        parse_mode: 'HTML',
        reply_markup: cancelKeyboard(),
      });
      return;
    }

    // Wizard Step: Extension Issue Description
    if (draft.kind === 'extension' && draft.step === 'ext_issue') {
      const issue = text.slice(0, 3000);
      if (!issue) {
        await safeSendMessage({
          chat_id: chatId,
          text: '⚠️ Please describe what is wrong with this extension.',
          parse_mode: 'HTML',
        });
        return;
      }

      let parsedExts = [];
      try {
        if (draft.extensionNames) parsedExts = JSON.parse(draft.extensionNames);
      } catch {}
      if (parsedExts.length > 0) {
        parsedExts[0].issue = issue;
      }

      await db.update(reportDrafts)
        .set({
          extensionNames: JSON.stringify(parsedExts),
          body: issue,
          step: 'ext_repo',
        })
        .where(eq(reportDrafts.userId, userId))
        .run();

      await safeSendMessage({
        chat_id: chatId,
        text: `<b>🧩 Step 10/11: Extension Repository URL (Required)</b>\nPaste the link to the extension source repository (e.g. <code>https://github.com/...</code>):`,
        parse_mode: 'HTML',
        reply_markup: cancelKeyboard(),
      });
      return;
    }

    // Wizard Step: Extension Repository URL
    if (draft.kind === 'extension' && draft.step === 'ext_repo') {
      const repoUrl = text.slice(0, 2000);
      if (!repoUrl || !repoUrl.startsWith('http')) {
        await safeSendMessage({
          chat_id: chatId,
          text: '⚠️ Extension repository URL is required. Please paste a valid URL starting with http:// or https://',
          parse_mode: 'HTML',
        });
        return;
      }

      await db.update(reportDrafts)
        .set({
          extensionRepo: repoUrl,
          step: 'attachments',
        })
        .where(eq(reportDrafts.userId, userId))
        .run();

      await safeSendMessage({
        chat_id: chatId,
        text: `<b>📎 Step 11/11: Attachments (Required)</b>\nAt least 1 attachment is required (side-by-side comparison showing the extension working in its native app vs failing in AnymeX).\n\n<i>Please send your screenshot or video comparison now:</i>`,
        parse_mode: 'HTML',
        reply_markup: cancelKeyboard(),
      });
      return;
    }

    // Wizard Step: Media Upload (Attachments)
    if (hasMedia && (draft.step === 'attachments' || draft.step === 'review')) {
      let currentAttachments = [];
      try {
        if (draft.attachments) currentAttachments = JSON.parse(draft.attachments);
      } catch {}

      if (photo) {
        currentAttachments.push({ type: 'image', file_id: photo.file_id, file_name: 'screenshot.jpg' });
      } else if (animation) {
        currentAttachments.push({ type: 'video', file_id: animation.file_id, file_name: animation.file_name || 'animation.mp4' });
      } else if (video) {
        currentAttachments.push({ type: 'video', file_id: video.file_id, file_name: video.file_name || 'screen_record.mp4' });
      } else if (document) {
        const docName = document.file_name || 'document.bin';
        const docMime = (document.mime_type || '').toLowerCase();
        let docType = 'file';
        if (docMime.startsWith('image/')) docType = 'image';
        else if (docMime.startsWith('video/')) docType = 'video';
        currentAttachments.push({ type: docType, file_id: document.file_id, file_name: docName });
      } else if (audio) {
        currentAttachments.push({ type: 'file', file_id: audio.file_id, file_name: audio.file_name || 'audio.mp3' });
      }

      await db.update(reportDrafts)
        .set({
          attachments: JSON.stringify(currentAttachments),
          step: 'review',
        })
        .where(eq(reportDrafts.userId, userId))
        .run();

      const updated = await db.select().from(reportDrafts).where(eq(reportDrafts.userId, userId)).get();

      await safeSendMessage({
        chat_id: chatId,
        text: `✅ <b>Attachment saved! (${currentAttachments.length} total)</b>\n\n` + formatDraftPreview(updated),
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: `✅ Confirm & Submit ${draft.kind === 'suggestion' ? 'Suggestion' : 'Report'}`, callback_data: 'submit_now' }],
            [{ text: '❌ Cancel', callback_data: 'cancel_wizard' }],
          ],
        },
      });
      return;
    }

    // If user sent plain text while waiting for required attachment in bug or extension
    if (draft.step === 'attachments' && !hasMedia) {
      await safeSendMessage({
        chat_id: chatId,
        text: `⚠️ <b>Attachment required:</b> On AnymeX Desk, at least one attachment (screenshot, screen recording, log file, crash report, or document) is required for ${draft.kind === 'bug' ? 'bugs' : 'extension issues'}.\n\nPlease send any screenshot, video, log, or file:`,
        parse_mode: 'HTML',
        reply_markup: cancelKeyboard(),
      });
      return;
    }

  } catch (err) {
    console.error('handlers/message uncaught error:', err);
    try {
      if (message?.chat?.id) {
        await safeSendMessage({
          chat_id: message.chat.id,
          text: `⚠️ <b>Something went wrong:</b> ${escapeHtml(err.message || 'Unknown error')}\n\nPlease try again or type /cancel to reset.`,
          parse_mode: 'HTML',
        });
      }
    } catch {}
  }
}
