import type { APIRoute } from 'astro';
import { db } from '../../../lib/db/client';
import { sql } from 'drizzle-orm';
import { KIND_LABELS, STATUS_LABELS } from '../../../lib/db/schema';

export const prerender = false;

export const GET: APIRoute = async (ctx) => {
  const url = new URL(ctx.request.url);
  const rawQ = (url.searchParams.get('q') || '').trim();
  const q = rawQ.startsWith('#') ? rawQ.slice(1).trim() : rawQ;

  try {
    const isNum = /^\d+$/.test(q);
    const numVal = isNum ? parseInt(q, 10) : -1;
    const pattern = `%${q.toLowerCase()}%`;
    const prefixPattern = `${q.toLowerCase()}%`;

    let whereClause = sql`1=1`;
    if (q) {
      if (isNum) {
        whereClause = sql`id = ${numVal} OR cast(id as text) LIKE ${q + '%'}`;
      } else {
        whereClause = sql`lower(title) LIKE ${pattern} OR lower(category) LIKE ${pattern} OR lower(kind) LIKE ${pattern}`;
      }
    }

    const rows = await db().all<{
      id: number;
      kind: string;
      category: string;
      title: string;
      votes: number;
      status: string;
    }>(sql`
      SELECT id, kind, category, title, votes, status
      FROM reports
      WHERE ${whereClause}
      ORDER BY 
        ${isNum ? sql`CASE WHEN id = ${numVal} THEN 0 ELSE 1 END,` : sql`CASE WHEN lower(title) LIKE ${prefixPattern} THEN 0 ELSE 1 END,`}
        votes DESC,
        id DESC
      LIMIT 60
    `);

    // Group kind-wise: bugs, suggestions, extensions
    const grouped: Record<
      string,
      Array<{
        id: number;
        title: string;
        kind: string;
        kindLabel: string;
        status: string;
        statusLabel: string;
        votes: number;
        category: string;
      }>
    > = {
      bug: [],
      suggestion: [],
      extension: [],
    };

    for (const r of rows) {
      const item = {
        ...r,
        kindLabel: KIND_LABELS[r.kind as keyof typeof KIND_LABELS] || r.kind,
        statusLabel: STATUS_LABELS[r.status as keyof typeof STATUS_LABELS] || r.status,
      };

      if (!grouped[r.kind]) {
        grouped[r.kind] = [];
      }
      grouped[r.kind].push(item);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        grouped,
        total: rows.length,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=5',
        },
      },
    );
  } catch (err: any) {
    console.error('[reports-search] Search error:', err);
    return new Response(JSON.stringify({ ok: false, error: err?.message || 'Search failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
