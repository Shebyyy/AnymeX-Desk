import { normalizeTitle } from './db/schema';

/**
 * Deduplication helpers for suggestions.
 * Replaces the old source-request dedup logic.
 */

export interface OpenSuggestion {
  id: number;
  title: string;
  category: string;
}

/**
 * Find a duplicate suggestion by normalized title match.
 * Two people asking for the same thing should upvote, not duplicate.
 */
export function duplicateSuggestion<T extends OpenSuggestion>(
  open: readonly T[],
  title: string,
  category: string,
): T | undefined {
  const norm = normalizeTitle(title);
  if (!norm.length) return undefined;
  return open.find(
    (r) => r.category === category && normalizeTitle(r.title) === norm,
  );
}

/**
 * Suggest similar open suggestions as the user types.
 * Returns nearest matches first, up to `limit`.
 */
export function suggestSimilar<T extends OpenSuggestion>(
  open: readonly T[],
  query: string,
  category?: string,
  limit = 6,
): T[] {
  const norm = normalizeTitle(query);
  if (norm.length < 2) return [];

  const starts: T[] = [];
  const contains: T[] = [];
  for (const r of open) {
    if (category && r.category !== category) continue;
    const title = normalizeTitle(r.title);
    if (title.startsWith(norm)) starts.push(r);
    else if (title.includes(norm)) contains.push(r);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}
