export const BOT_NAME = 'Omni';
export const BOT_HANDLE = 'OmniBot';

export const COMMANDS = [
  { command: 'start', description: 'Open main menu and features' },
  { command: 'anime', description: 'Search Anime (/anime <title>)' },
  { command: 'manga', description: 'Search Manga (/manga <title>)' },
  { command: 'novel', description: 'Search Light Novels (/novel <title>)' },
  { command: 'sauce', description: 'Identify anime scene from image' },
  { command: 'airing', description: 'Upcoming episode airing schedule' },
  { command: 'mytracks', description: 'View tracked media and subscriptions' },
  { command: 'sync', description: 'Import watchlist from AniList (/sync <user>)' },
  { command: 'help', description: 'Usage guide and commands' },
];

export const STATUS_LABELS = {
  FINISHED: '✅ Finished',
  RELEASING: '🟢 Releasing / Airing',
  NOT_YET_RELEASED: '⏳ Not Yet Aired',
  CANCELLED: '❌ Cancelled',
  HIATUS: '⏸ Hiatus',
};

export const FORMAT_LABELS = {
  TV: '📺 TV',
  TV_SHORT: '📺 TV Short',
  MOVIE: '🎬 Movie',
  SPECIAL: '⭐ Special',
  OVA: '📀 OVA',
  ONA: '🌐 ONA',
  MANGA: '📖 Manga',
  NOVEL: '📚 Light Novel',
  ONE_SHOT: '📄 One Shot',
};

/**
 * Generate AnymeX App deep link.
 */
export function getAnymeXDeepLink(type, id) {
  const mediaType = type === 'MANGA' ? 'manga' : 'anime';
  return `anymex://anilist/${mediaType}/${id}`;
}

/**
 * Generate Web fallback URL.
 */
export function getWebLink(type, id) {
  const mediaType = type === 'MANGA' ? 'manga' : 'anime';
  return `https://anilist.co/${mediaType}/${id}`;
}
