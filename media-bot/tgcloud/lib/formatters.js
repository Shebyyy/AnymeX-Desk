import { STATUS_LABELS, FORMAT_LABELS } from './constants.js';
import { formatTimestamp } from './tracemoe.js';

export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatCountdown(seconds) {
  if (!seconds || seconds <= 0) return 'Airing soon!';
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);

  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || parts.length === 0) parts.push(`${m}m`);
  return parts.join(' ');
}

/**
 * Format full media details for a Telegram message.
 */
export function formatMediaCard(media, isTracked = false) {
  const title = media.title?.english || media.title?.romaji || media.title?.native || 'Unknown Title';
  const subTitle = media.title?.romaji && media.title?.english && media.title.romaji !== media.title.english
    ? `<i>(${escapeHtml(media.title.romaji)})</i>\n`
    : '';

  const format = FORMAT_LABELS[media.format] || media.format || 'Media';
  const status = STATUS_LABELS[media.status] || media.status || 'Unknown';
  const score = media.averageScore ? `⭐ <b>${media.averageScore}%</b>` : '⭐ N/A';

  let countText = '';
  if (media.type === 'ANIME') {
    countText = media.episodes ? `📺 <b>Episodes:</b> ${media.episodes}` : '📺 <b>Episodes:</b> Releasing';
  } else {
    const ch = media.chapters ? `${media.chapters} ch` : '? ch';
    const vol = media.volumes ? ` (${media.volumes} vol)` : '';
    countText = `📖 <b>Chapters:</b> ${ch}${vol}`;
  }

  let airingText = '';
  if (media.nextAiringEpisode) {
    const ep = media.nextAiringEpisode.episode;
    const cd = formatCountdown(media.nextAiringEpisode.timeUntilAiring);
    airingText = `\n⏰ <b>Episode ${ep}:</b> Airs in <code>${cd}</code>`;
  }

  const genres = media.genres && media.genres.length > 0
    ? `🏷 <b>Genres:</b> ${media.genres.slice(0, 4).join(', ')}\n`
    : '';

  // Clean description of HTML tags
  let desc = (media.description || '')
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .trim();
  if (desc.length > 300) {
    desc = desc.substring(0, 300) + '...';
  }

  const trackingBadge = isTracked ? '🔔 <b>Tracking Enabled</b>\n' : '';

  return (
    `✨ <b>${escapeHtml(title)}</b>\n` +
    subTitle +
    `\n` +
    `🏷 <b>Format:</b> ${format}  •  ${status}\n` +
    `${score}  •  ${countText}${airingText}\n` +
    genres +
    trackingBadge +
    (desc ? `\n📝 <i>${escapeHtml(desc)}</i>` : '')
  );
}

/**
 * Format reverse image search match from trace.moe.
 */
export function formatSauceCard(match, anilistMedia = null) {
  const similarity = (match.similarity * 100).toFixed(1);
  const confidenceEmoji = match.similarity >= 0.88 ? '🎯 High Confidence' : (match.similarity >= 0.80 ? '🟡 Moderate' : '⚠️ Low Match');

  const title = anilistMedia
    ? (anilistMedia.title?.english || anilistMedia.title?.romaji || 'Unknown Anime')
    : (match.filename || 'Unknown Scene');

  const ep = match.episode !== null && match.episode !== undefined ? `Episode ${match.episode}` : 'Movie / Special';
  const time = `${formatTimestamp(match.from)} - ${formatTimestamp(match.to)}`;

  return (
    `🔍 <b>Scene Identified!</b>\n\n` +
    `🎬 <b>Anime:</b> <b>${escapeHtml(title)}</b>\n` +
    `📺 <b>Episode:</b> ${ep}\n` +
    `⏱ <b>Timestamp:</b> <code>${time}</code>\n` +
    `📊 <b>Match Accuracy:</b> <b>${similarity}%</b> (${confidenceEmoji})\n\n` +
    `<i>Tap the button below to stream in AnymeX or view full series info:</i>`
  );
}

/**
 * Format daily airing schedule list.
 */
export function formatAiringList(schedules) {
  if (!schedules || schedules.length === 0) {
    return '📅 <b>No upcoming episodes found in the schedule.</b>';
  }

  let text = '📅 <b>Upcoming Anime Airing Schedule:</b>\n\n';

  schedules.slice(0, 10).forEach((item, index) => {
    const title = item.media.title.english || item.media.title.romaji || 'Anime';
    const cd = formatCountdown(item.timeUntilAiring);
    const score = item.media.averageScore ? `⭐ ${item.media.averageScore}%` : '';

    text += `${index + 1}. <b>${escapeHtml(title)}</b>\n`;
    text += `   📺 Ep ${item.episode}  •  ⏳ in <code>${cd}</code> ${score}\n\n`;
  });

  text += `<i>Tip: Tap /track &lt;name&gt; to get a notification when new episodes drop!</i>`;
  return text;
}
