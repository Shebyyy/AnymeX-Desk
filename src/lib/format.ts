import { OTHER_STATUSES, CATEGORY_LABELS, PLATFORM_LABELS, STATUS_LABELS, KIND_LABELS } from './db/schema';
import type { BoardState } from './queries';

/* --- time formatting ---------------------------------------------------- */

export function relativeAge(createdAt: number, now = Date.now() / 1000): string {
  const s = Math.max(0, now - createdAt);
  const m = Math.floor(s / 60);
  if (m < 1) return '1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(s / 3600);
  if (h < 24) return `${h}h`;
  const d = Math.floor(s / 86_400);
  if (d < 30) return `${d}d`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
}

/** A fixed day, said once: "24 August 2026". */
export function absoluteDate(iso: string): string {
  const parts = new Map(
    new Intl.DateTimeFormat('en', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value] as const),
  );
  return `${parts.get('day')} ${parts.get('month')} ${parts.get('year')}`;
}

/* --- status formatting --------------------------------------------------- */

/**
 * Only the genuinely neglected get called out, and in words. Median open age
 * here is 69 days, so "old" is not remarkable — "ignored" is.
 */
export function stalledLabel(createdAt: number, now = Date.now() / 1000): string | null {
  const days = (now - createdAt) / 86_400;
  if (days < 90) return null;
  const months = Math.floor(days / 30);
  return months >= 12 ? `waiting ${Math.floor(months / 12)}y` : `waiting ${months} months`;
}

/**
 * When a closed report was closed, as one phrase rather than a badge plus a date.
 */
export function fixedLabel(
  status: string,
  statusChangedAt: number | null,
  now = Date.now() / 1000,
): string | null {
  if (!statusChangedAt) return null;
  const closed = status === 'fixed' || (OTHER_STATUSES as readonly string[]).includes(status);
  if (!closed) return null;
  return `${statusLabel(status)} ${relativeAge(statusChangedAt, now)} ago`;
}

/** Display label for a report status. */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/** Display label for a report kind (bug / suggestion). */
export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/** Display label for a category. */
export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

/** Display label for a platform. */
export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

/* --- board views ---------------------------------------------------------- */

/** Which kind the board is showing. Matches queries.BoardFilter. */
export type BoardKind = 'bug' | 'suggestion' | 'extension';

/**
 * Everything a page says about the view it is showing.
 */
export interface BoardViewCopy {
  /** The chip label in FilterBar's state group. */
  chip: string;
  /** The `<title>` and the `<h1>`. */
  heading: string;
  /** The sentence under the h1. */
  lede: string;
  /** Empty-state copy. */
  emptyTitle: string;
  emptyFiltered: string;
  emptyAlone: string;
  /** Where an empty board sends people. */
  cta: { href: string; label: string; primary?: boolean };
  /** The order this view leads with. */
  defaultSort: 'demand' | 'fixed';
  /** What the pager counts in. */
  pagerNoun: string;
}

const BUG_VIEWS: Record<BoardState, BoardViewCopy> = {
  open: {
    chip: 'Open',
    heading: 'Bugs',
    lede: 'Ranked by how many people are hit. Reporting something already listed just adds you to it.',
    emptyTitle: 'Nothing broken here',
    emptyFiltered: 'No open bugs match these filters. Try widening them.',
    emptyAlone: 'No open bugs yet. If something is broken, be the first to report it.',
    cta: { href: '/new?kind=bug', label: 'Report a bug', primary: true },
    defaultSort: 'demand',
    pagerNoun: 'open bugs',
  },
  fixed: {
    chip: 'Fixed',
    heading: 'Fixed bugs',
    lede: 'Reports that have been fixed, most recently closed first.',
    emptyTitle: 'Nothing fixed here yet',
    emptyFiltered: 'No fixed bugs match these filters. Try widening them.',
    emptyAlone: 'No bug has been marked fixed yet.',
    cta: { href: '/', label: 'See what is still open' },
    defaultSort: 'fixed',
    pagerNoun: 'fixed bugs',
  },
  other: {
    chip: 'Other',
    heading: "Won't fix and duplicates",
    lede: 'Reports closed without a fix: decided against, or merged into another report.',
    emptyTitle: 'Nothing here yet',
    emptyFiltered: 'No closed reports match these filters. Try widening them.',
    emptyAlone: 'Nothing has been closed without a fix yet.',
    cta: { href: '/', label: 'See what is still open' },
    defaultSort: 'fixed',
    pagerNoun: 'closed without a fix',
  },
};

const SUGGESTION_VIEWS: Record<BoardState, BoardViewCopy> = {
  open: {
    chip: 'Open',
    heading: 'Suggestions',
    lede: 'Feature suggestions for AnymeX, ranked by demand.',
    emptyTitle: 'No open suggestions',
    emptyFiltered: 'No open suggestions match these filters. Try widening them.',
    emptyAlone: 'No open suggestions yet. Have an idea? Be the first to suggest it.',
    cta: { href: '/new?kind=suggestion', label: 'Suggest a feature', primary: true },
    defaultSort: 'demand',
    pagerNoun: 'open suggestions',
  },
  fixed: {
    chip: 'Done',
    heading: 'Implemented suggestions',
    lede: 'Suggestions that have been implemented, most recently finished first.',
    emptyTitle: 'Nothing implemented yet',
    emptyFiltered: 'No implemented suggestions match these filters.',
    emptyAlone: 'Nothing has been implemented yet.',
    cta: { href: '/', label: 'See what people are suggesting' },
    defaultSort: 'fixed',
    pagerNoun: 'implemented suggestions',
  },
  other: {
    chip: 'Other',
    heading: "Declined and duplicates",
    lede: 'Suggestions turned down, or marked as duplicates of another.',
    emptyTitle: 'Nothing here yet',
    emptyFiltered: 'Nothing here matches these filters.',
    emptyAlone: 'Nothing has been declined yet.',
    cta: { href: '/', label: 'See what people are suggesting' },
    defaultSort: 'fixed',
    pagerNoun: 'closed without being implemented',
  },
};

const EXTENSION_VIEWS: Record<BoardState, BoardViewCopy> = {
  open: {
    chip: 'Open',
    heading: 'Extension Issues',
    lede: 'Extensions that work in their native app but not in AnymeX, ranked by demand.',
    emptyTitle: 'No open extension issues',
    emptyFiltered: 'No open extension issues match these filters. Try widening them.',
    emptyAlone: 'No open extension issues yet. Found one? Be the first to report it.',
    cta: { href: '/new?kind=extension', label: 'Report an extension issue', primary: true },
    defaultSort: 'demand',
    pagerNoun: 'open extension issues',
  },
  fixed: {
    chip: 'Fixed',
    heading: 'Fixed extension issues',
    lede: 'Extension issues that have been fixed, most recently closed first.',
    emptyTitle: 'Nothing fixed here yet',
    emptyFiltered: 'No fixed extension issues match these filters. Try widening them.',
    emptyAlone: 'No extension issue has been marked fixed yet.',
    cta: { href: '/', label: 'See what is still open' },
    defaultSort: 'fixed',
    pagerNoun: 'fixed extension issues',
  },
  other: {
    chip: 'Other',
    heading: "Won't fix and duplicates",
    lede: 'Extension issues closed without a fix: decided against, or merged into another report.',
    emptyTitle: 'Nothing here yet',
    emptyFiltered: 'No closed reports match these filters. Try widening them.',
    emptyAlone: 'Nothing has been closed without a fix yet.',
    cta: { href: '/', label: 'See what is still open' },
    defaultSort: 'fixed',
    pagerNoun: 'closed without a fix',
  },
};

export const BOARD_VIEW_COPY: Record<BoardKind, Record<BoardState, BoardViewCopy>> = {
  bug: BUG_VIEWS,
  suggestion: SUGGESTION_VIEWS,
  extension: EXTENSION_VIEWS,
};
