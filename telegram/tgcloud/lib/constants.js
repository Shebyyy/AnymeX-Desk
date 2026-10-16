// Exact constants mirroring AnymeX Desk (schema.ts)

export const DESK_BASE_URL = 'https://anymex-desk.asheby.workers.dev';
export const DESK_SYNC_SECRET = 'anymex_sync_8f4a9b2c6e1d3075e82f419c8a74e5bd';
export const BOT_USERNAME = 'AnymeXDeskBot';
export const BOT_URL = `https://t.me/${BOT_USERNAME}`;

export const PLATFORMS = ['android', 'windows', 'ios', 'macos', 'linux', 'all'];

export const PLATFORM_LABELS = {
  android: '📱 Android',
  windows: '🪟 Windows',
  ios: '🍎 iOS',
  macos: '🍏 macOS',
  linux: '🐧 Linux',
  all: '🌐 All Platforms',
};

export const RELEASE_CHANNELS = {
  stable: '🟢 Stable Release',
  beta: '🧪 Beta / Pre-release',
};

export const BUG_CATEGORIES = [
  'video_player',
  'ui_ux',
  'login_auth',
  'manga_reader',
  'crash',
  'performance',
  'novel_reader',
  'library',
  'tracking',
  'other',
];

export const BUG_CATEGORY_LABELS = {
  video_player: '🎬 Video Player',
  ui_ux: '🎨 UI / UX',
  login_auth: '🔐 Login / Auth',
  manga_reader: '📖 Manga Reader',
  crash: '💥 Crash / Freeze',
  performance: '⚡ Performance',
  novel_reader: '📚 Novel Reader',
  library: '📁 Library',
  tracking: '📊 Tracking Sync',
  other: '⚙️ Other',
};

export const SUGGESTION_CATEGORIES = [
  'player',
  'ui_ux',
  'library',
  'tracking',
  'extensions',
  'manga_reader',
  'novel_reader',
  'download',
  'other',
];

export const SUGGESTION_CATEGORY_LABELS = {
  player: '🎬 Player',
  ui_ux: '🎨 UI / UX',
  library: '📁 Library',
  tracking: '📊 Tracking',
  extensions: '🧩 Extensions',
  manga_reader: '📖 Manga Reader',
  novel_reader: '📚 Novel Reader',
  download: '⬇️ Download',
  other: '⚙️ Other',
};

export const EXTENSION_SOURCES = [
  'mihon_aniyomi',
  'mangayomi',
  'sora',
  'lnreader',
  'cloudstream',
  'kotatsu',
];

export const EXTENSION_SOURCE_LABELS = {
  mihon_aniyomi: '📖 Mihon / Aniyomi',
  mangayomi: '📚 Mangayomi',
  sora: '🌌 Sora',
  lnreader: '📝 LNReader',
  cloudstream: '☁️ Cloudstream',
  kotatsu: '📑 Kotatsu',
};

export const CATEGORY_LABELS = {
  ...BUG_CATEGORY_LABELS,
  ...SUGGESTION_CATEGORY_LABELS,
  ...EXTENSION_SOURCE_LABELS,
};

export const STATUS_LABELS = {
  open: 'Open',
  under_review: 'Under Review',
  confirmed: 'Confirmed',
  in_progress: 'In Progress',
  fixed: 'Fixed',
  wont_fix: "Won't Fix",
  duplicate: 'Duplicate',
  already_available: 'Already Available',
};

export const STATUS_EMOJIS = {
  open: '🔵',
  under_review: '🟣',
  confirmed: '🟢',
  in_progress: '🟡',
  fixed: '✅',
  wont_fix: '❌',
  duplicate: '🔗',
  already_available: '💡',
};

export const KIND_LABELS = {
  bug: '🐛 Bug',
  suggestion: '💡 Suggestion',
  extension: '🧩 Extension Issue',
};
