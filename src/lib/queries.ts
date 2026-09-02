import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from './db/client';
import { inIds } from './db/sql';
import { KINDS, OPEN_STATUSES, OTHER_STATUSES, STATUSES, reports, votes, type Report } from './db/schema';

export type Sort = 'demand' | 'stalled' | 'recent' | 'fixed';

/**
 * Which third of the backlog a board is showing.
 *
 * `fixed` shows reports marked as fixed.
 * `other` shows wont_fix and duplicate.
 * `open` (default) shows everything still being worked on.
 */
export type BoardState = 'open' | 'fixed' | 'other';

/**
 * Query string → BoardState. Unrecognised values fall back to `open`.
 */
export function parseBoardState(raw: string | null): BoardState {
  return raw === 'fixed' || raw === 'other' ? raw : 'open';
}

/** Rows per page. */
export const PAGE_SIZE = 60;

export interface BoardFilter {
  /** `bug`, `suggestion`, or `extension`. */
  kind?: 'bug' | 'suggestion' | 'extension';
  /** Category to filter by (e.g. 'video_player', 'ui_ux'). */
  category?: string;
  /** Platform to filter by (e.g. 'android', 'windows'). */
  platform?: string;
  /** Which third of the backlog is on screen. */
  state?: BoardState;
  /** Status to filter by. */
  status?: string;
  sort?: Sort;
  limit?: number;
  /** Rows to skip — the pager's position. */
  offset?: number;
}

/** Ninety days, which is the threshold `stalledLabel` in lib/format.ts prints. */
const STALLED_AFTER = 7_776_000;

/**
 * The columns a board row renders, and nothing else.
 *
 * Kept minimal so the ORDER BY sorter carries less through a temp B-tree.
 */
const ROW_COLUMNS = {
  id: reports.id,
  kind: reports.kind,
  category: reports.category,
  platform: reports.platform,
  appVersion: reports.appVersion,
  title: reports.title,
  status: reports.status,
  duplicateOf: reports.duplicateOf,
  votes: reports.votes,
  attachmentCount: reports.attachmentCount,
  commentCount: reports.commentCount,
  statusChangedAt: reports.statusChangedAt,
  createdAt: reports.createdAt,
} as const;

export async function board(f: BoardFilter) {
  const state = f.state ?? 'open';
  const statusFilter =
    state === 'fixed'
      ? eq(reports.status, 'fixed')
      : state === 'other'
        ? inArray(reports.status, [...OTHER_STATUSES])
        : inArray(reports.status, [...OPEN_STATUSES]);

  const where: Parameters<typeof and>[number][] = [statusFilter];
  if (f.kind) where.push(eq(reports.kind, f.kind));
  if (f.category) where.push(eq(reports.category, f.category));
  if (f.platform) where.push(eq(reports.platform, f.platform));
  if (f.status) where.push(eq(reports.status, f.status as never));

  /*
   * Sort defaults: open board uses demand, closed boards use most recently closed.
   */
  const sort: Sort =
    state === 'open'
      ? f.sort === 'fixed'
        ? 'demand'
        : (f.sort ?? 'demand')
      : f.sort === 'demand'
        ? 'demand'
        : 'fixed';

  const order =
    sort === 'fixed'
      ? [desc(sql`coalesce(${reports.statusChangedAt}, ${reports.updatedAt})`)]
      : sort === 'recent'
        ? [desc(reports.createdAt)]
        : sort === 'stalled'
          ? [asc(reports.createdAt), desc(reports.votes)]
          : [desc(reports.votes), asc(reports.createdAt)];

  const limit = f.limit ?? PAGE_SIZE;
  const offset = Math.max(0, f.offset ?? 0);

  const [rows, [tally]] = await Promise.all([
    db()
      .select(ROW_COLUMNS)
      .from(reports)
      .where(and(...where))
      .orderBy(...order)
      .limit(limit)
      .offset(offset),
    db()
      .select({ total: count() })
      .from(reports)
      .where(and(...where)),
  ]);

  return { rows: rows as Report[], total: tally?.total ?? 0, limit, offset };
}

/** Which of these reports has the viewer already backed? */
export async function myVotes(discordId: string, reportIds: number[]) {
  if (!reportIds.length) return new Set<number>();
  const rows = await db()
    .select({ reportId: votes.reportId })
    .from(votes)
    .where(and(eq(votes.discordId, discordId), inIds(votes.reportId, reportIds)));
  return new Set(rows.map((r) => r.reportId));
}

/** Open / fixed / other / stalled tallies for one report kind. */
export interface KindCounts {
  open: number;
  fixed: number;
  other: number;
  stalled: number;
}

/** Header counters, one entry per kind in {@link KINDS}. */
export type BoardCounts = Record<(typeof KINDS)[number], KindCounts>;

/**
 * Header counters. One round trip, not one query per kind.
 *
 * All columns referenced are in reports_tallies, so this stays a covering index read.
 * Generic over {@link KINDS}, so a new report kind needs no change here.
 */
export async function boardCounts(): Promise<BoardCounts> {
  const stalled = sql`created_at < unixepoch() - ${STALLED_AFTER}`;
  const isOpen = sql`status in ('open', 'confirmed', 'in_progress')`;
  const isFixed = sql`status = 'fixed'`;
  const isOther = sql`status in ('wont_fix', 'duplicate')`;

  const selection = Object.fromEntries(
    KINDS.flatMap((k) => {
      const isKind = sql`kind = ${k}`;
      return [
        [`${k}__open`, sql<number>`sum(case when ${isKind} and ${isOpen} then 1 else 0 end)`],
        [`${k}__fixed`, sql<number>`sum(case when ${isKind} and ${isFixed} then 1 else 0 end)`],
        [`${k}__other`, sql<number>`sum(case when ${isKind} and ${isOther} then 1 else 0 end)`],
        [`${k}__stalled`, sql<number>`sum(case when ${isKind} and ${isOpen} and ${stalled} then 1 else 0 end)`],
      ];
    }),
  ) as Record<string, ReturnType<typeof sql<number>>>;

  const where = [inArray(reports.status, [...STATUSES])];
  const [row] = await db().select(selection).from(reports).where(and(...where));

  const out = {} as BoardCounts;
  for (const k of KINDS) {
    out[k] = {
      open: Number((row as Record<string, unknown>)?.[`${k}__open`] ?? 0),
      fixed: Number((row as Record<string, unknown>)?.[`${k}__fixed`] ?? 0),
      other: Number((row as Record<string, unknown>)?.[`${k}__other`] ?? 0),
      stalled: Number((row as Record<string, unknown>)?.[`${k}__stalled`] ?? 0),
    };
  }
  return out;
}
