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

export function formatReportList(reports, title = 'Top Reports') {
  if (!reports || reports.length === 0) {
    return `<b>${title}</b>\n\n<i>No reports found matching your criteria.</i>`;
  }

  let text = `<b>${title}</b>\n\n`;
  for (let i = 0; i < reports.length; i++) {
    const r = reports[i];
    const emoji = STATUS_EMOJIS[r.status] || '⚪';
    const plat = PLATFORM_LABELS[r.platform] || r.platform;
    text += `<b>${i + 1}.</b> <a href="${DESK_BASE_URL}/report/${r.id}">#${r.id} ${escapeHtml(r.title)}</a>\n`;
    text += `   ${emoji} ${r.status}  •  ${plat}  •  ▲ ${r.votes || 0} votes\n\n`;
  }

  return text;
}
