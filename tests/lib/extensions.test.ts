import { describe, it, expect } from 'bun:test';
import { parseExtensionEntries, formatExtensionEntriesForDiscord } from '../../src/lib/extensions';

describe('parseExtensionEntries', () => {
  it('returns empty array for empty or null input', () => {
    expect(parseExtensionEntries(null)).toEqual([]);
    expect(parseExtensionEntries('')).toEqual([]);
    expect(parseExtensionEntries('   ')).toEqual([]);
  });

  it('parses valid JSON array with names, versions, and issues', () => {
    const raw = JSON.stringify([
      { name: 'Gogoanime', version: '1.4.2', issue: 'Error 403 on video player' },
      { name: 'AllAnime', version: '2.0.1', issue: 'Search fails' },
    ]);
    expect(parseExtensionEntries(raw)).toEqual([
      { name: 'Gogoanime', version: '1.4.2', issue: 'Error 403 on video player' },
      { name: 'AllAnime', version: '2.0.1', issue: 'Search fails' },
    ]);
  });

  it('parses legacy multiline string without versions', () => {
    const raw = 'Gogoanime\nAllAnime\nMangaDex';
    expect(parseExtensionEntries(raw)).toEqual([
      { name: 'Gogoanime', version: '' },
      { name: 'AllAnime', version: '' },
      { name: 'MangaDex', version: '' },
    ]);
  });

  it('parses legacy multiline string with parentheses version format', () => {
    const raw = 'Gogoanime (v1.4.2)\nAllAnime (2.0.1)';
    expect(parseExtensionEntries(raw)).toEqual([
      { name: 'Gogoanime', version: '1.4.2' },
      { name: 'AllAnime', version: '2.0.1' },
    ]);
  });

  it('parses malformed JSON by falling back to line parsing', () => {
    const raw = '[{"name": "Gogoanime"';
    expect(parseExtensionEntries(raw)).toEqual([
      { name: '[{"name": "Gogoanime"', version: '' },
    ]);
  });
});

describe('formatExtensionEntriesForDiscord', () => {
  it('formats entries with versions and issues properly', () => {
    const entries = [
      { name: 'Gogoanime', version: '1.4.2', issue: 'Video playback error 403' },
      { name: 'AllAnime', version: 'v2.0.1' },
      { name: 'MangaDex', version: '' },
    ];
    const res = formatExtensionEntriesForDiscord(entries);
    expect(res).toBe('• **Gogoanime** (v1.4.2)\n  > Video playback error 403\n• **AllAnime** (v2.0.1)\n• **MangaDex**');
  });

  it('returns empty string for empty array', () => {
    expect(formatExtensionEntriesForDiscord([])).toBe('');
  });
});
