import { getAnymeXDeepLink, getWebLink } from './constants.js';

export function mediaCardKeyboard(media, isTracked = false, page = 1, totalPages = 1, query = '', type = 'ANIME') {
  const deepLink = getAnymeXDeepLink(media.type, media.id);
  const webLink = getWebLink(media.type, media.id);

  const inline_keyboard = [
    [
      { text: '▶️ Open in AnymeX', url: deepLink },
      { text: '🌐 AniList', url: webLink },
    ],
    [
      {
        text: isTracked ? '🔕 Stop Tracking' : '🔔 Track New Releases',
        callback_data: `track:${media.type}:${media.id}`,
      },
    ],
  ];

  if (totalPages > 1) {
    const navRow = [];
    if (page > 1) {
      navRow.push({ text: '◀️ Prev', callback_data: `page:${type}:${encodeURIComponent(query)}:${page - 1}` });
    }
    navRow.push({ text: `[ ${page} / ${totalPages} ]`, callback_data: 'noop' });
    if (page < totalPages) {
      navRow.push({ text: 'Next ▶️', callback_data: `page:${type}:${encodeURIComponent(query)}:${page + 1}` });
    }
    inline_keyboard.push(navRow);
  }

  return { inline_keyboard };
}

export function sauceKeyboard(anilistId, videoUrl = null) {
  const inline_keyboard = [];

  if (anilistId) {
    inline_keyboard.push([
      { text: '▶️ Stream in AnymeX', url: getAnymeXDeepLink('ANIME', anilistId) },
      { text: '🌐 AniList Info', url: getWebLink('ANIME', anilistId) },
    ]);
  }

  if (videoUrl) {
    inline_keyboard.push([
      { text: '🎬 Preview Scene Clip', url: videoUrl },
    ]);
  }

  return { inline_keyboard };
}

export function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🎬 Search Anime', callback_data: 'prompt:anime' },
        { text: '📖 Search Manga', callback_data: 'prompt:manga' },
      ],
      [
        { text: '📚 Light Novels', callback_data: 'prompt:novel' },
        { text: '🔍 Sauce / Reverse Image', callback_data: 'prompt:sauce' },
      ],
      [
        { text: '📅 Airing Schedule', callback_data: 'nav:airing' },
        { text: '🔔 My Tracked Titles', callback_data: 'nav:mytracks' },
      ],
      [
        { text: '🌐 Get AnymeX App', url: 'https://github.com/RyanYuuki/AnymeX' },
      ],
    ],
  };
}
