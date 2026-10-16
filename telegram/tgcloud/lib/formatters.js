import {
  STATUS_EMOJIS,
  STATUS_LABELS,
  KIND_LABELS,
  PLATFORM_LABELS,
  BUG_CATEGORY_LABELS,
  SUGGESTION_CATEGORY_LABELS,
  EXTENSION_SOURCE_LABELS,
  DESK_BASE_URL,
} from './constants.js';

export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatReportCard(report) {
  const statusEmoji = STATUS_EMOJIS[report.status] || '⚪';
  const statusName = STATUS_LABELS[report.status] || report.status;
  const kindName = KIND_LABELS[report.kind] || report.kind;
  const platName = PLATFORM_LABELS[report.platform] || report.platform;
  
  let catName = report.category;
  if (report.kind === 'bug') catName = BUG_CATEGORY_LABELS[report.category] || report.category;
  else if (report.kind === 'suggestion') catName = SUGGESTION_CATEGORY_LABELS[report.category] || report.category;
  else if (report.kind === 'extension') catName = EXTENSION_SOURCE_LABELS[report.category] || report.category;

  let text = `<b>${statusEmoji} [${kindName}] #${report.id}: ${escapeHtml(report.title)}</b>\n\n`;
  text += `📊 <b>Status:</b> ${statusEmoji} ${statusName}\n`;
  text += `🏷 <b>Category:</b> ${catName}\n`;
  text += `📱 <b>Platform:</b> ${platName}\n`;
  if (report.appVersion) {
    text += `📦 <b>Version:</b> <code>${escapeHtml(report.appVersion)}</code>\n`;
  }
  text += `▲ <b>Votes:</b> ${report.votes || 0}  •  💬 <b>Comments:</b> ${report.commentCount || 0}\n\n`;

  if (report.stepsToReproduce) {
    text += `<b>Steps to Reproduce:</b>\n<i>${escapeHtml(report.stepsToReproduce.slice(0, 400))}</i>\n\n`;
  }

  if (report.body) {
    text += `<b>Description:</b>\n${escapeHtml(report.body.slice(0, 500))}${report.body.length > 500 ? '...' : ''}\n\n`;
  }

  text += `🔗 <a href="${DESK_BASE_URL}/report/${report.id}">Open on AnymeX Desk</a>`;
  return text;
}

export function formatDraftPreview(draft) {
  const kindLabel = KIND_LABELS[draft.kind] || draft.kind;
  const kindEmoji = draft.kind === 'bug' ? '🐛' : (draft.kind === 'suggestion' ? '💡' : '🧩');
  const platName = PLATFORM_LABELS[draft.platform] || draft.platform || 'All Platforms';

  let catName = draft.category || 'General';
  if (draft.kind === 'bug') catName = BUG_CATEGORY_LABELS[draft.category] || draft.category;
  else if (draft.kind === 'suggestion') catName = SUGGESTION_CATEGORY_LABELS[draft.category] || draft.category;
  else if (draft.kind === 'extension') catName = EXTENSION_SOURCE_LABELS[draft.category] || draft.category;

  let text = `📋 <b>Review Your Report Summary:</b>\n\n`;
  text += `🏷 <b>Type:</b> ${kindEmoji} ${kindLabel}\n`;
  text += `📂 <b>Category:</b> ${catName}\n`;
  text += `📱 <b>Platform:</b> ${platName}`;
  if (draft.releaseChannel) {
    text += ` (${draft.releaseChannel === 'beta' ? '🧪 Beta' : '🟢 Stable'})\n`;
  } else {
    text += `\n`;
  }

  if (draft.appVersion) {
    text += `📦 <b>Version:</b> <code>${escapeHtml(draft.appVersion)}</code>\n`;
  }

  text += `📌 <b>Title:</b> <b>${escapeHtml(draft.title || 'Untitled')}</b>\n\n`;

  if (draft.stepsToReproduce) {
    text += `📝 <b>Steps to Reproduce:</b>\n<i>${escapeHtml(draft.stepsToReproduce.slice(0, 600))}</i>\n\n`;
  }

  if (draft.body) {
    text += `📄 <b>Details / Proposal:</b>\n<i>${escapeHtml(draft.body.slice(0, 600))}</i>\n\n`;
  }

  let attachCount = 0;
  try {
    if (draft.attachments) {
      const parsed = JSON.parse(draft.attachments);
      attachCount = Array.isArray(parsed) ? parsed.length : 0;
    }
  } catch {}

  if (attachCount > 0) {
    text += `📎 <b>Attachments:</b> ${attachCount} file(s) attached\n\n`;
  }

  text += `━━━━━━━━━━━━━━━━━━━━\n`;
  text += `<i>Ready to submit? Tap <b>✅ Confirm & Submit</b> below.\n`;
  text += `Or send any extra message/screenshot to add to the report.</i>`;

  return text;
}

export function formatReportList(reports, title = 'Top Reports', page = 1, pageSize = 6) {
  if (!reports || reports.length === 0) {
    return `<b>${title}</b>\n\n<i>No reports found matching your criteria.</i>`;
  }

  const start = (page - 1) * pageSize;
  const items = reports.slice(start, start + pageSize);
  const total = reports.length;

  if (items.length === 0) {
    return `<b>${title}</b>\n\n<i>No more reports on this page.</i>`;
  }

  let text = `<b>${title}</b> (${start + 1}-${Math.min(start + items.length, total)} of ${total})\n\n`;
  for (let i = 0; i < items.length; i++) {
    const r = items[i];
    const emoji = STATUS_EMOJIS[r.status] || '⚪';
    const plat = PLATFORM_LABELS[r.platform] || r.platform;
    const cat = CATEGORY_LABELS[r.category] || r.category;
    const cleanTitle = escapeHtml(r.title ? r.title.slice(0, 75) : 'Untitled');
    text += `<b>${start + i + 1}.</b> <a href="${DESK_BASE_URL}/report/${r.id}">#${r.id} ${cleanTitle}</a>\n`;
    text += `   ${emoji} <code>${r.status}</code>  •  ${plat}  •  ${cat}  •  ▲ ${r.votes || 0}\n\n`;
  }

  return text.slice(0, 3900);
}
