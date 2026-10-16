import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import { reportDrafts, watchers } from '../schema.js';
import {
  mainMenuKeyboard,
  reportCardKeyboard,
  categoryKeyboard,
  platformKeyboard,
} from '../lib/keyboards.js';
import {
  getReports,
  getReportDetails,
  searchSimilar,
  submitReport,
} from '../lib/desk_api.js';
import { formatReportList, formatReportCard, escapeHtml } from '../lib/formatters.js';
import { DESK_BASE_URL } from '../lib/constants.js';

export default async function (message) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const user = message.from;
  const rawText = (message.text || '').trim();
  // Strip bot mention if command was sent in a group (e.g. /bugs@AnymeXDeskBot -> /bugs)
  const text = rawText.replace(/^(\/[a-zA-Z0-9_]+)@\w+bot\b/i, '$1');

  // 1. Slash Commands
  if (text.startsWith('/start') || text.startsWith('/help')) {
    await db.delete(reportDrafts).where(eq(reportDrafts.userId, userId)).run();

    // Register the slash command popup menu in Telegram for both private chats and groups
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
    await api.setMyCommands({ commands, scope: { type: 'all_group_chats' } }).catch(() => {});

    const welcome = `<b>👋 Welcome to AnymeX Desk Bot!</b>\n\n` +
      `This bot lets you search, track, and report bugs or feature suggestions for the <b>AnymeX</b> app directly inside Telegram.\n\n` +
      `<b>Quick Commands:</b>\n` +
      `• /bugs — View top open bugs\n` +
      `• /suggestions — View feature requests\n` +
      `• /report <code>&lt;id&gt;</code> — View ticket details & status\n` +
      `• /bug — File a new bug report\n` +
      `• /suggest — Propose a new feature\n` +
      `• /ext — Report a broken extension\n\n` +
      `<i>Tip: You can also type <code>@AnymeXDeskBot player lag</code> in any chat to search tickets inline!</i>`;

    await api.sendMessage({
      chat_id: chatId,
      text: welcome,
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  if (text === '/cancel') {
    await db.delete(reportDrafts).where(eq(reportDrafts.userId, userId)).run();
    await api.sendMessage({
      chat_id: chatId,
      text: '<i>Report creation cancelled. Use /bug or /suggest whenever you are ready.</i>',
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  if (text === '/bugs') {
    const res = await getReports({ kind: 'bug', state: 'open', page: 1 });
    const listText = formatReportList(res.data, '🐛 Top Open Bugs');
    await api.sendMessage({
      chat_id: chatId,
      text: listText,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '➕ File a Bug', callback_data: 'start:bug' },
            { text: '🔍 Search', switch_inline_query_current_chat: '' },
          ],
        ],
      },
    });
    return;
  }

  if (text === '/suggestions') {
    const res = await getReports({ kind: 'suggestion', state: 'open', page: 1 });
    const listText = formatReportList(res.data, '💡 Top Feature Suggestions');
    await api.sendMessage({
      chat_id: chatId,
      text: listText,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '💡 Propose Feature', callback_data: 'start:suggestion' },
            { text: '🔍 Search', switch_inline_query_current_chat: '' },
          ],
        ],
      },
    });
    return;
  }

  if (text.startsWith('/report') || text.startsWith('/status')) {
    const parts = text.split(' ');
    const id = Number(parts[1]);
    if (!id || isNaN(id)) {
      await api.sendMessage({
        chat_id: chatId,
        text: '<i>Please specify a report ID: e.g. <code>/report 104</code></i>',
        parse_mode: 'HTML',
      });
      return;
    }

    const report = await getReportDetails(id);
    if (!report) {
      await api.sendMessage({
        chat_id: chatId,
        text: `❌ <i>Report #${id} was not found on AnymeX Desk.</i>`,
        parse_mode: 'HTML',
      });
      return;
    }

    const card = formatReportCard(report);
    await api.sendMessage({
      chat_id: chatId,
      text: card,
      parse_mode: 'HTML',
      reply_markup: reportCardKeyboard(report.id, report.votes || 0, false),
    });
    return;
  }

  if (text === '/bug') {
    await db.delete(reportDrafts).where(eq(reportDrafts.userId, userId)).run();
    await db.insert(reportDrafts).values({
      userId,
      kind: 'bug',
      step: 'platform',
    }).run();

    await api.sendMessage({
      chat_id: chatId,
      text: '<b>🐛 Step 1/6: Select the platform where the bug occurs:</b>',
      parse_mode: 'HTML',
      reply_markup: platformKeyboard('plat'),
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

    await api.sendMessage({
      chat_id: chatId,
      text: '<b>💡 Step 1/4: Select the category for your feature suggestion:</b>',
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
      step: 'source',
    }).run();

    await api.sendMessage({
      chat_id: chatId,
      text: '<b>🧩 Step 1/5: Which extension source engine is having issues?</b>',
      parse_mode: 'HTML',
      reply_markup: categoryKeyboard('extension', 'cat'),
    });
    return;
  }

  // 2. Active Wizard Text Input
  const draft = await db.select().from(reportDrafts).where(eq(reportDrafts.userId, userId)).get();
  if (!draft) {
    // Regular unprompted message
    await api.sendMessage({
      chat_id: chatId,
      text: `<i>I didn't recognize that command. Type /help to see available actions.</i>`,
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(),
    });
    return;
  }

  // Handle Wizard Step: Version
  if (draft.step === 'version') {
    const ver = text.slice(0, 32);
    await db.update(reportDrafts)
      .set({ appVersion: ver, step: 'title' })
      .where(eq(reportDrafts.userId, userId))
      .run();

    await api.sendMessage({
      chat_id: chatId,
      text: `Version set to: <code>${escapeHtml(ver)}</code>\n\n<b>🐛 Step 5/6: Send a short, clear title for this bug:</b>\n(e.g. <i>Video freezes when seeking 1080p stream</i>)`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel_wizard' }]],
      },
    });
    return;
  }

  // Handle Wizard Step: Title
  if (draft.step === 'title') {
    const title = text.slice(0, 200);

    // Run similarity check to detect potential duplicates
    const similar = await searchSimilar(title, draft.kind);
    if (similar.length > 0) {
      const topHit = similar[0];
      await api.sendMessage({
        chat_id: chatId,
        text: `⚠️ <b>Similar report already found on Desk!</b>\n\n` +
          `<b>#${topHit.id}: ${escapeHtml(topHit.title)}</b>\n` +
          `Status: <code>${topHit.status}</code>  •  ▲ ${topHit.votes} votes\n\n` +
          `Instead of creating a duplicate, you can upvote the existing ticket below!`,
        parse_mode: 'HTML',
        reply_markup: reportCardKeyboard(topHit.id, topHit.votes, false),
      });
    }

    if (draft.kind === 'bug') {
      await db.update(reportDrafts)
        .set({ title, step: 'steps' })
        .where(eq(reportDrafts.userId, userId))
        .run();

      await api.sendMessage({
        chat_id: chatId,
        text: `Title: <b>${escapeHtml(title)}</b>\n\n<b>🐛 Step 6/6: What are the steps to reproduce this bug?</b>\n(e.g.\n1. Open episode\n2. Seek forward\n3. App crashes)`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel_wizard' }]],
        },
      });
    } else if (draft.kind === 'suggestion') {
      await db.update(reportDrafts)
        .set({ title, step: 'body' })
        .where(eq(reportDrafts.userId, userId))
        .run();

      await api.sendMessage({
        chat_id: chatId,
        text: `Title: <b>${escapeHtml(title)}</b>\n\n<b>💡 Step 4/4: Describe your suggestion in detail:</b>\n(Why is it needed, how should it work, and what makes it useful?)`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel_wizard' }]],
        },
      });
    }
    return;
  }

  // Handle Wizard Step: Steps to Reproduce (Bugs)
  if (draft.step === 'steps') {
    const steps = text.slice(0, 5000);
    await db.update(reportDrafts)
      .set({ stepsToReproduce: steps, step: 'body' })
      .where(eq(reportDrafts.userId, userId))
      .run();

    await api.sendMessage({
      chat_id: chatId,
      text: `<b>Almost done!</b> Provide any extra details, expected vs actual behavior, or error message (or send <code>done</code> to submit):`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '✅ Submit Report Now', callback_data: 'submit_now' }]],
      },
    });
    return;
  }

  // Handle Wizard Step: Extension Name & Version
  if (draft.step === 'ext_name') {
    const extName = text.slice(0, 200);
    await db.update(reportDrafts)
      .set({
        extensionNames: JSON.stringify([{ name: extName, version: '1.0', issue: '' }]),
        title: `[${draft.category}] ${extName} issue`,
        step: 'ext_issue',
      })
      .where(eq(reportDrafts.userId, userId))
      .run();

    await api.sendMessage({
      chat_id: chatId,
      text: `Extension: <b>${escapeHtml(extName)}</b>\n\n<b>🧩 Step 5/5: Describe the exact error or problem:</b>\n(e.g. <i>Source fails to load stream / Cloudflare bypass loop / missing chapters</i>)`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel_wizard' }]],
      },
    });
    return;
  }

  // Handle Final Submission: Body / Details
  if (draft.step === 'body' || draft.step === 'ext_issue') {
    const bodyText = text === 'done' ? (draft.stepsToReproduce || '') : text.slice(0, 5000);

    const payload = {
      kind: draft.kind,
      category: draft.category || 'other',
      platform: draft.platform || 'all',
      releaseChannel: draft.releaseChannel || 'stable',
      appVersion: draft.appVersion || 'Latest',
      title: draft.title || `Issue reported by @${user.username || user.first_name}`,
      body: bodyText,
      stepsToReproduce: draft.stepsToReproduce || null,
      testedNativeApp: draft.testedNativeApp || false,
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
      // Auto-watch this report
      await db.insert(watchers).values({
        userId,
        chatId,
        reportId: result.reportId,
      }).run();

      await db.delete(reportDrafts).where(eq(reportDrafts.userId, userId)).run();

      const successMsg = `🎉 <b>Report #${result.reportId} Filed Successfully!</b>\n\n` +
        `📌 <b>Title:</b> ${escapeHtml(payload.title)}\n` +
        `📱 <b>Platform:</b> ${payload.platform}  •  🏷 <b>Category:</b> ${payload.category}\n` +
        `🌐 <b>Desk URL:</b> <a href="${DESK_BASE_URL}/report/${result.reportId}">View Report on Desk</a>\n\n` +
        `🔔 <i>You are now watching this ticket! We'll send you a Telegram DM when maintainers update the status or comment.</i>`;

      await api.sendMessage({
        chat_id: chatId,
        text: successMsg,
        parse_mode: 'HTML',
        reply_markup: reportCardKeyboard(result.reportId, 1, true),
      });
    } else {
      await api.sendMessage({
        chat_id: chatId,
        text: `❌ <b>Submission Error:</b> ${escapeHtml(result.error || 'Failed to submit report. Please try again.')}`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel_wizard' }]],
        },
      });
    }
  }
}
