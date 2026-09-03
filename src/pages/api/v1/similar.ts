import type { APIRoute } from 'astro';
import { db } from '../../../lib/db/client';
import { sql } from 'drizzle-orm';
import { CATEGORY_LABELS, PLATFORM_LABELS, KIND_LABELS } from '../../../lib/db/schema';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=0, s-maxage=30',
    },
  });
}

/**
 * GET /api/v1/similar?q=...&kind=...
 *
 * Fast similarity search for duplicate warning on /new.
 * Looks for open/confirmed/in_progress reports whose titles match closely.
 */
export const GET: APIRoute = async (ctx) => {
  const q = (ctx.url.searchParams.get('q') ?? '').trim();
  const kind = (ctx.url.searchParams.get('kind') ?? '').trim();

  if (q.length < 3) {
    return json({ results: [] });
  }

  try {
    // Try FTS first if available
    const ftsResults = await db().all(sql`
      SELECT r.id, r.kind, r.category, r.platform, r.title, r.votes, r.status
      FROM fts_reports f
      JOIN reports r ON r.id = f.rowid
      WHERE fts_reports MATCH ${q + '*'}
        AND (${!kind} OR r.kind = ${kind})
        AND r.status IN ('open', 'confirmed', 'in_progress')
      ORDER BY r.votes DESC, f.rank
      LIMIT 3
    `) as { id: number; kind: string; category: string; platform: string; title: string; votes: number; status: string }[];

    if (ftsResults.length > 0) {
      return json({
        results: ftsResults.map((r) => ({
          ...r,
          kindLabel: KIND_LABELS[r.kind] ?? r.kind,
          categoryLabel: CATEGORY_LABELS[r.category] ?? r.category,
          platformLabel: PLATFORM_LABELS[r.platform] ?? r.platform,
        })),
      });
    }
  } catch {
    // Fall back to LIKE
  }

  // Fallback LIKE query
  const likeResults = await db().all(sql`
    SELECT id, kind, category, platform, title, votes, status
    FROM reports
    WHERE lower(title) LIKE ${'%' + q.toLowerCase() + '%'}
      AND (${!kind} OR kind = ${kind})
      AND status IN ('open', 'confirmed', 'in_progress')
    ORDER BY votes DESC, created_at DESC
    LIMIT 3
  `) as { id: number; kind: string; category: string; platform: string; title: string; votes: number; status: string }[];

  return json({
    results: likeResults.map((r) => ({
      ...r,
      kindLabel: KIND_LABELS[r.kind] ?? r.kind,
      categoryLabel: CATEGORY_LABELS[r.category] ?? r.category,
      platformLabel: PLATFORM_LABELS[r.platform] ?? r.platform,
    })),
  });
};
