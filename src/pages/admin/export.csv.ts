import type { APIRoute } from 'astro';
import { db } from '../../lib/db/client';
import { sql } from 'drizzle-orm';
import { requireStaff, isResponse } from '../../lib/staff';

export const prerender = false;

function escapeCsv(field: string | number | null | undefined): string {
  if (field === null || field === undefined) return '';
  const str = String(field);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * GET /admin/export.csv — Admin-only CSV export of all reports.
 */
export const GET: APIRoute = async (ctx) => {
  const gate = await requireStaff(ctx, 'mod');
  if (isResponse(gate)) return gate;

  const rows = (await db().all(sql`
    SELECT id, kind, category, platform, app_version, title, status, votes,
           attachment_count, comment_count, created_at, status_changed_at,
           roadmap_stage, milestone
    FROM reports
    ORDER BY id ASC
  `)) as {
    id: number;
    kind: string;
    category: string;
    platform: string;
    app_version: string | null;
    title: string;
    status: string;
    votes: number;
    attachment_count: number;
    comment_count: number;
    created_at: number;
    status_changed_at: number | null;
    roadmap_stage: string | null;
    milestone: string | null;
  }[];

  const headers = [
    'ID',
    'Kind',
    'Category',
    'Platform',
    'AppVersion',
    'Title',
    'Status',
    'Votes',
    'Attachments',
    'Comments',
    'CreatedAt',
    'StatusChangedAt',
    'RoadmapStage',
    'Milestone',
  ];

  const csvLines = [headers.join(',')];

  for (const r of rows) {
    csvLines.push(
      [
        r.id,
        r.kind,
        r.category,
        r.platform,
        r.app_version,
        r.title,
        r.status,
        r.votes,
        r.attachment_count,
        r.comment_count,
        new Date(r.created_at * 1000).toISOString(),
        r.status_changed_at ? new Date(r.status_changed_at * 1000).toISOString() : '',
        r.roadmap_stage ?? '',
        r.milestone ?? '',
      ]
        .map(escapeCsv)
        .join(','),
    );
  }

  const csv = csvLines.join('\r\n');

  return new Response(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="anymex-desk-reports-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'private, no-store',
    },
  });
};
