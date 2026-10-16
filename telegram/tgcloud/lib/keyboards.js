import {
  PLATFORM_LABELS,
  BUG_CATEGORIES,
  BUG_CATEGORY_LABELS,
  SUGGESTION_CATEGORIES,
  SUGGESTION_CATEGORY_LABELS,
  EXTENSION_SOURCES,
  EXTENSION_SOURCE_LABELS,
  DESK_BASE_URL,
} from './constants.js';

export function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🐛 Report a Bug', callback_data: 'start:bug' },
        { text: '💡 Suggest Feature', callback_data: 'start:suggestion' },
      ],
      [
        { text: '🧩 Extension Issue', callback_data: 'start:extension' },
        { text: '📋 Top Open Bugs', callback_data: 'list:bugs:1' },
      ],
      [
        { text: '🔍 Search Tickets', switch_inline_query_current_chat: '' },
        { text: '🌐 Open Desk Web', url: DESK_BASE_URL },
      ],
    ],
  };
}

export function platformKeyboard(prefix = 'plat') {
  return {
    inline_keyboard: [
      [
        { text: PLATFORM_LABELS.android, callback_data: `${prefix}:android` },
        { text: PLATFORM_LABELS.windows, callback_data: `${prefix}:windows` },
      ],
      [
        { text: PLATFORM_LABELS.ios, callback_data: `${prefix}:ios` },
        { text: PLATFORM_LABELS.macos, callback_data: `${prefix}:macos` },
      ],
      [
        { text: PLATFORM_LABELS.linux, callback_data: `${prefix}:linux` },
        { text: PLATFORM_LABELS.all, callback_data: `${prefix}:all` },
      ],
      [
        { text: '❌ Cancel', callback_data: 'cancel_wizard' },
      ],
    ],
  };
}

export function releaseChannelKeyboard(prefix = 'chan') {
  return {
    inline_keyboard: [
      [
        { text: '🟢 Stable Release', callback_data: `${prefix}:stable` },
        { text: '🧪 Beta / Pre-release', callback_data: `${prefix}:beta` },
      ],
      [
        { text: '❌ Cancel', callback_data: 'cancel_wizard' },
      ],
    ],
  };
}

export function categoryKeyboard(kind, prefix = 'cat') {
  const rows = [];
  let items = [];

  if (kind === 'bug') {
    items = BUG_CATEGORIES.map((k) => ({ key: k, label: BUG_CATEGORY_LABELS[k] }));
  } else if (kind === 'suggestion') {
    items = SUGGESTION_CATEGORIES.map((k) => ({ key: k, label: SUGGESTION_CATEGORY_LABELS[k] }));
  } else if (kind === 'extension') {
    items = EXTENSION_SOURCES.map((k) => ({ key: k, label: EXTENSION_SOURCE_LABELS[k] }));
  }

  for (let i = 0; i < items.length; i += 2) {
    const row = [{ text: items[i].label, callback_data: `${prefix}:${items[i].key}` }];
    if (items[i + 1]) {
      row.push({ text: items[i + 1].label, callback_data: `${prefix}:${items[i + 1].key}` });
    }
    rows.push(row);
  }

  rows.push([{ text: '❌ Cancel', callback_data: 'cancel_wizard' }]);

  return { inline_keyboard: rows };
}

export function nativeAppGateKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '✅ Works in native app (Only fails in AnymeX)', callback_data: 'gate:native_ok' },
      ],
      [
        { text: '❌ Also fails in native app', callback_data: 'gate:native_fail' },
      ],
      [
        { text: '❌ Cancel', callback_data: 'cancel_wizard' },
      ],
    ],
  };
}

export function skipOrCancelKeyboard(skipAction = 'skip') {
  return {
    inline_keyboard: [
      [
        { text: '⏩ Skip', callback_data: skipAction },
        { text: '❌ Cancel', callback_data: 'cancel_wizard' },
      ],
    ],
  };
}

export function reportCardKeyboard(reportId, votes = 0, isWatched = false) {
  return {
    inline_keyboard: [
      [
        { text: `▲ Upvote (${votes})`, callback_data: `vote:${reportId}` },
        { text: isWatched ? '🔕 Unwatch' : '🔔 Watch Updates', callback_data: `watch:${reportId}` },
      ],
      [
        { text: '🌐 View on AnymeX Desk', url: `${DESK_BASE_URL}/report/${reportId}` },
      ],
    ],
  };
}

export function triageKeyboard(reportId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Confirm', callback_data: `triage:${reportId}:confirmed` },
        { text: '🔨 In Progress', callback_data: `triage:${reportId}:in_progress` },
      ],
      [
        { text: '🎉 Mark Fixed', callback_data: `triage:${reportId}:fixed` },
        { text: '🔗 Duplicate', callback_data: `triage:${reportId}:duplicate` },
      ],
      [
        { text: "❌ Won't Fix", callback_data: `triage:${reportId}:wont_fix` },
        { text: '🌐 Open Web', url: `${DESK_BASE_URL}/report/${reportId}` },
      ],
    ],
  };
}
