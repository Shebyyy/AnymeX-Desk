/**
 * Client-side user preferences manager.
 * Stores settings in localStorage and updates documentElement data-attributes in real time.
 */

export type UIScale = 'compact' | 'default' | 'comfortable' | 'large';
export type ThemeMode = 'midnight' | 'oled' | 'light' | 'system';
export type AccentColor = 'gold' | 'purple' | 'blue' | 'emerald' | 'pink' | 'crimson';
export type DefaultPlatform = '' | 'android' | 'windows' | 'ios' | 'macos' | 'linux';
export type DefaultSort = 'demand' | 'recent' | 'stalled';

export interface UserPreferences {
  scale: UIScale;
  theme: ThemeMode;
  accent: AccentColor;
  defaultPlatform: DefaultPlatform;
  defaultSort: DefaultSort;
  reduceMotion: boolean;
  highContrast: boolean;
  codeWrap: boolean;
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  scale: 'default',
  theme: 'midnight',
  accent: 'gold',
  defaultPlatform: '',
  defaultSort: 'demand',
  reduceMotion: false,
  highContrast: false,
  codeWrap: false,
};

const STORAGE_KEY = 'anymex_desk_prefs';

export function getPreferences(): UserPreferences {
  if (typeof window === 'undefined') return { ...DEFAULT_PREFERENCES };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    return { ...DEFAULT_PREFERENCES, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function applyPreferences(prefs: UserPreferences): void {
  if (typeof document === 'undefined') return;
  const doc = document.documentElement;

  // Scale
  if (prefs.scale === 'default') doc.removeAttribute('data-scale');
  else doc.setAttribute('data-scale', prefs.scale);

  // Theme
  if (prefs.theme === 'midnight') doc.removeAttribute('data-theme');
  else if (prefs.theme === 'system') {
    doc.removeAttribute('data-theme');
  } else {
    doc.setAttribute('data-theme', prefs.theme);
  }

  // Accent
  if (prefs.accent === 'gold') doc.removeAttribute('data-accent');
  else doc.setAttribute('data-accent', prefs.accent);

  // Reduce motion
  if (prefs.reduceMotion) doc.setAttribute('data-reduce-motion', 'true');
  else doc.removeAttribute('data-reduce-motion');

  // High contrast
  if (prefs.highContrast) doc.setAttribute('data-high-contrast', 'true');
  else doc.removeAttribute('data-high-contrast');

  // Code wrap
  if (prefs.codeWrap) doc.setAttribute('data-code-wrap', 'true');
  else doc.removeAttribute('data-code-wrap');
}

export function savePreferences(patch: Partial<UserPreferences>): UserPreferences {
  const current = getPreferences();
  const updated = { ...current, ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Ignore storage quota errors
  }
  applyPreferences(updated);
  return updated;
}

export function resetPreferences(): UserPreferences {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
  applyPreferences(DEFAULT_PREFERENCES);
  return { ...DEFAULT_PREFERENCES };
}
