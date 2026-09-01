import { normName } from './requests';

/**
 * Open suggestions, fetched once per page and decoded in one place.
 *
 * Client-safe on purpose: nothing here imports the database.
 */

export interface SuggestionRow {
  id: number;
  kind: string;
  category: string;
  title: string;
  votes: number;
}

export interface SuggestionFeed {
  suggestions: SuggestionRow[];
}

/** The positional payload the route emits — see src/pages/suggestions.json.ts. */
type Payload = {
  s: [number, string, string, string, number][];
};

let inflight: Promise<SuggestionFeed> | null = null;
let fetchedAt = 0;
const MAX_AGE_MS = 60_000;

export function loadSuggestionFeed(): Promise<SuggestionFeed> {
  if (inflight && Date.now() - fetchedAt > MAX_AGE_MS) inflight = null;
  if (inflight) return inflight;
  fetchedAt = Date.now();
  const thisFetch = fetch('/suggestions.json')
    .then((res) => {
      if (!res.ok) throw new Error(`/suggestions.json answered ${res.status}`);
      return res.json() as Promise<Payload>;
    })
    .then(({ s = [] }) => ({
      suggestions: s.map(([id, kind, category, title, votes]) => ({
        id,
        kind,
        category,
        title,
        votes,
      })),
    }))
    .catch((err) => {
      if (inflight === thisFetch) inflight = null;
      throw err;
    });
  inflight = thisFetch;
  return inflight;
}

/**
 * Find a suggestion that might be a duplicate, based on normalised title.
 */
export function findDuplicateSuggestion(
  open: readonly SuggestionRow[],
  title: string,
  category: string,
): SuggestionRow | undefined {
  const n = normName(title);
  if (!n) return undefined;
  return open.find(
    (r) => r.category === category && normName(r.title) === n,
  );
}

/**
 * Suggestions matching a query string, for a search-while-you-type box.
 */
export function suggestSuggestions(
  open: readonly SuggestionRow[],
  query: string,
  category?: string,
  limit = 6,
): SuggestionRow[] {
  const n = normName(query);
  if (n.length < 2) return [];

  const starts: SuggestionRow[] = [];
  const contains: SuggestionRow[] = [];
  for (const r of open) {
    if (category && r.category !== category) continue;
    const title = normName(r.title);
    if (title.startsWith(n)) starts.push(r);
    else if (title.includes(n)) contains.push(r);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
}
