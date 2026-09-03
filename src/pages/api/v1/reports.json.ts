import type { APIRoute } from 'astro';
import { board } from '../../../lib/queries';
import { KINDS, PLATFORMS, KIND_LABELS, CATEGORY_LABELS, PLATFORM_LABELS } from '../../../lib/db/schema';

export const prerender = false;

/**
 * GET /api/v1/reports.json
 *
 * Read-only public API. Returns open reports with vote counts.
 * Supports: ?kind=bug|suggestion|extension, ?platform=android|…, ?category=…,
 *           ?state=open|fixed|other, ?page=N (1-indexed)
 *
 * Rate-limited by Cloudflare's free tier at the WAF level.
 * No auth required — all data is already public on the board.
 */
function json(data: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      ...headers,
    },
  });
}

export const GET: APIRoute = async (ctx) => {
  const q = ctx.url.searchParams;

  const rawKind = q.get('kind') ?? '';
  const kind = (KINDS as readonly string[]).includes(rawKind)
    ? (rawKind as (typeof KINDS)[number])
    : undefined;

  const rawPlatform = q.get('platform') ?? '';
  const platform = (PLATFORMS as readonly string[]).includes(rawPlatform) ? rawPlatform : '';

  const rawCat = q.get('category') ?? '';
  const category = rawCat.length > 0 ? rawCat : '';

  const rawState = q.get('state') ?? '';
  const state =
    rawState === 'fixed' || rawState === 'other' ? rawState : 'open';

  const page = Math.max(1, parseInt(q.get('page') ?? '1', 10) || 1);
  const PAGE = 50;
  const offset = (page - 1) * PAGE;

  const { rows, total } = await board({
    kind,
    platform,
    category,
    state: state as 'open' | 'fixed' | 'other',
    limit: PAGE,
    offset,
  });

  const data = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    kindLabel: KIND_LABELS[r.kind] ?? r.kind,
    category: r.category,
    categoryLabel: CATEGORY_LABELS[r.category] ?? r.category,
    platform: r.platform,
    platformLabel: PLATFORM_LABELS[r.platform] ?? r.platform,
    title: r.title,
    status: r.status,
    votes: r.votes,
    commentCount: r.commentCount,
    attachmentCount: r.attachmentCount,
    appVersion: r.appVersion ?? null,
    createdAt: r.createdAt,
    url: `${ctx.url.origin}/report/${r.id}`,
  }));

  return json(
    {
      data,
      meta: {
        total,
        page,
        pageSize: PAGE,
        hasNextPage: offset + PAGE < total,
        hasPrevPage: page > 1,
      },
    },
    200,
    {
      'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
    },
  );
};
