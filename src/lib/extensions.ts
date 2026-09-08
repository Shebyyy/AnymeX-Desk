export interface ExtensionEntry {
  name: string;
  version: string;
  issue?: string;
}

/**
 * Parses raw extension data from database or form into structured ExtensionEntry objects.
 * Handles:
 * - JSON array of { name, version, issue? } (current format)
 * - Legacy plain-text multiline strings from older reports (backward compatibility)
 */
export function parseExtensionEntries(raw: string | null | undefined): ExtensionEntry[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // 1. Try parsing as JSON array
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const results: ExtensionEntry[] = [];
        for (const item of parsed) {
          if (!item) continue;
          if (typeof item === 'string') {
            const name = item.trim();
            if (name) results.push({ name, version: '' });
          } else if (typeof item === 'object') {
            const name = String(item.name ?? '').trim();
            const version = String(item.version ?? '').trim();
            const issue = String(item.issue ?? item.description ?? '').trim();
            if (name) results.push({ name, version, issue: issue || undefined });
          }
        }
        if (results.length > 0) return results;
      }
    } catch {
      // Fall through to legacy plain text parsing
    }
  }

  // 2. Legacy fallback: parse line-by-line
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      // Check if line has a format like "Name (v1.2.3)" or "Name - v1.2.3"
      const parenMatch = line.match(/^(.+?)\s*\(\s*(?:v)?([0-9a-zA-Z._-]+)\s*\)$/i);
      if (parenMatch) {
        return { name: parenMatch[1].trim(), version: parenMatch[2].trim() };
      }
      const dashMatch = line.match(/^(.+?)\s*[-—–]\s*(?:v)?([0-9a-zA-Z._-]+)$/i);
      if (dashMatch) {
        return { name: dashMatch[1].trim(), version: dashMatch[2].trim() };
      }
      return { name: line, version: '' };
    });
}

/**
 * Formats a list of extension entries for Discord embeds or notifications.
 * Example:
 * • **Gogoanime** (v1.4.2)
 *   > Video player gives error 403
 * • **MangaDex** (v2.0.0)
 *   > Search results fail to load
 */
export function formatExtensionEntriesForDiscord(entries: ExtensionEntry[]): string {
  if (!entries.length) return '';
  return entries
    .map((e) => {
      const v = e.version ? ` (v${e.version.replace(/^v/i, '')})` : '';
      let line = `• **${e.name}**${v}`;
      if (e.issue) {
        const firstLine = e.issue.split(/\r?\n/)[0].trim().slice(0, 200);
        line += `\n  > ${firstLine}`;
      }
      return line;
    })
    .join('\n');
}
