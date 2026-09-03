import type { APIRoute } from 'astro';
import { db } from '../lib/db/client';
import { sql } from 'drizzle-orm';
import { KIND_LABELS, PLATFORM_LABELS, CATEGORY_LABELS } from '../lib/db/schema';

export const prerender = false;

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

/**
 * GET /feed.xml — RSS 2.0 syndication feed of fixed/shipped reports.
 */
export const GET: APIRoute = async (ctx) => {
  const origin = ctx.url.origin;

  const items = (await db().all(sql`
    SELECT id, kind, category, platform, title, body, status_note AS statusNote,
           status_changed_at AS statusChangedAt
    FROM reports
    WHERE status = 'fixed'
    ORDER BY status_changed_at DESC, id DESC
    LIMIT 30
  `)) as {
    id: number;
    kind: string;
    category: string;
    platform: string;
    title: string;
    body: string | null;
    statusNote: string | null;
    statusChangedAt: number | null;
  }[];

  const buildDate = new Date().toUTCString();

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>AnymeX Desk — Fixed &amp; Shipped Updates</title>
    <link>${origin}/changelog</link>
    <description>Recent bug fixes, completed feature suggestions, and improvements for AnymeX.</description>
    <language>en-US</language>
    <lastBuildDate>${buildDate}</lastBuildDate>
    <atom:link href="${origin}/feed.xml" rel="self" type="application/rss+xml" />
    ${items
      .map((item) => {
        const itemUrl = `${origin}/report/${item.id}`;
        const pubDate = item.statusChangedAt
          ? new Date(item.statusChangedAt * 1000).toUTCString()
          : buildDate;
        const kind = KIND_LABELS[item.kind] ?? item.kind;
        const cat = CATEGORY_LABELS[item.category] ?? item.category;
        const plat = PLATFORM_LABELS[item.platform] ?? item.platform;

        const description = escapeXml(
          `[${kind} · ${cat} · ${plat}]\n\n${item.body ?? item.title}${
            item.statusNote ? `\n\nResolution note: ${item.statusNote}` : ''
          }`,
        );

        return `
    <item>
      <title>${escapeXml(`[${kind}] ${item.title}`)}</title>
      <link>${itemUrl}</link>
      <guid isPermaLink="true">${itemUrl}</guid>
      <pubDate>${pubDate}</pubDate>
      <category>${escapeXml(cat)}</category>
      <description>${description}</description>
    </item>`;
      })
      .join('')}
  </channel>
</rss>`;

  return new Response(xml, {
    status: 200,
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=0, s-maxage=600',
    },
  });
};
