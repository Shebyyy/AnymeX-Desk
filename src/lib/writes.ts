import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './db/client';
import { OPEN_STATUSES, normalizeTitle, reports } from './db/schema';

/**
 * Guards shared by the write paths (/new, /vote).
 *
 * Each one exists to stop a write that the form's own validation has no opinion
 * about — a report id that names nothing, a dedup collision, or a signed-in
 * account filing faster than a person could.
 */

/* --- filing cooldown ----------------------------------------------------- */

/**
 * How many reports one account may file per hour before we ask it to wait.
 *
 * There is no general rate limiter here on purpose. Bug reports are already
 * bounded by the unique index — the second person to hit the same issue
 * upvotes instead of inserting — so this only truly bounds novel filings.
 */
export const FILING_LIMIT = 6;
export const FILING_WINDOW_SECONDS = 3600;

/** Said on the form rather than raised as an error — being early is not a fault. */
export const FILING_COOLDOWN_MESSAGE =
  "You've filed several reports in the last hour. Give it a bit before the next one.";

export async function overFilingLimit(reporterId: string): Promise<boolean> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)` })
    .from(reports)
    .where(
      and(
        eq(reports.reporterId, reporterId),
        sql`${reports.createdAt} > unixepoch() - ${FILING_WINDOW_SECONDS}`,
      ),
    );
  return (row?.n ?? 0) >= FILING_LIMIT;
}

/* --- vote targets -------------------------------------------------------- */

/**
 * A report id has to survive being a foreign key.
 */
export const isReportId = (n: number) => Number.isSafeInteger(n) && n > 0;

/**
 * Whether this report exists and still counts as live demand.
 */
export async function isVotableReport(reportId: number): Promise<boolean> {
  const [row] = await db()
    .select({ id: reports.id })
    .from(reports)
    .where(and(eq(reports.id, reportId), inArray(reports.status, [...OPEN_STATUSES])));
  return !!row;
}

/* --- dedup check --------------------------------------------------------- */

export interface DedupHit {
  id: number;
  title: string;
  votes: number;
}

/**
 * Check whether an open report already covers this issue.
 *
 * The unique index is (kind, category, platform, title_normalized) for open
 * statuses, so we look for a match on those four columns. `title` passed in is
 * the raw user input; we normalize it the same way inserts do.
 */
export async function findDuplicate(
  kind: string,
  category: string,
  platform: string,
  title: string,
): Promise<DedupHit | null> {
  const normalized = normalizeTitle(title);
  const [row] = await db()
    .select({ id: reports.id, title: reports.title, votes: reports.votes })
    .from(reports)
    .where(
      and(
        eq(reports.kind, kind),
        eq(reports.category, category),
        eq(reports.platform, platform),
        eq(reports.titleNormalized, normalized),
        inArray(reports.status, [...OPEN_STATUSES]),
      ),
    );
  return row ?? null;
}
