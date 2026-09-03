import type { APIRoute } from 'astro';
<<<<<<< HEAD
import { db } from '../../lib/db/client';
import { reports } from '../../lib/db/schema';
import { eq } from 'drizzle-orm';
import { KIND_LABELS, STATUS_LABELS, PLATFORM_LABELS, CATEGORY_LABELS } from '../../lib/db/schema';
=======
import { db } from '../../../lib/db/client';
import { reports } from '../../../lib/db/schema';
import { eq } from 'drizzle-orm';
import { KIND_LABELS, STATUS_LABELS, PLATFORM_LABELS, CATEGORY_LABELS } from '../../../lib/db/schema';
>>>>>>> 4dc5424238a4b24e4ce6d958264d6f91e5fa79fb

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

/** Break a long title into lines of at most maxChars characters. */
function wrapText(text: string, maxChars = 34): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const w of words) {
    if ((current + ' ' + w).trim().length <= maxChars) {
      current = (current + ' ' + w).trim();
    } else {
      if (current) lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 3); // max 3 lines
}

export const GET: APIRoute = async (ctx) => {
  const id = Number(ctx.params.id);
  if (!Number.isInteger(id)) return new Response('Not Found', { status: 404 });

  const [report] = await db().select().from(reports).where(eq(reports.id, id));
  if (!report) return new Response('Not Found', { status: 404 });

  const kindLabel = KIND_LABELS[report.kind] ?? report.kind;
  const statusLabel = STATUS_LABELS[report.status] ?? report.status;
  const platformLabel = PLATFORM_LABELS[report.platform] ?? report.platform;
  const categoryLabel = CATEGORY_LABELS[report.category] ?? report.category;

  const kindColor = report.kind === 'suggestion' ? '#f5c542' : report.kind === 'extension' ? '#5865f2' : '#ed4245';
  const statusColor = report.status === 'fixed' ? '#57f287' : report.status === 'in_progress' ? '#f5c542' : '#9ca3af';

  const titleLines = wrapText(report.title, 32);

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="1200" height="630" viewBox="0 0 1200 630" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1200" y2="630" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#141416" />
      <stop offset="100%" stop-color="#1c1d21" />
    </linearGradient>
    <linearGradient id="cardBg" x1="0" y1="0" x2="0" y2="1" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#232429" />
      <stop offset="100%" stop-color="#18191d" />
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="1200" height="630" fill="url(#bg)" />
  <circle cx="1100" cy="80" r="300" fill="${kindColor}" fill-opacity="0.08" filter="blur(80px)" />
  <circle cx="100" cy="550" r="240" fill="#f5c542" fill-opacity="0.05" filter="blur(60px)" />

  <!-- Outer Card Frame -->
  <rect x="60" y="50" width="1080" height="530" rx="20" fill="url(#cardBg)" stroke="#32343c" stroke-width="2" />

  <!-- Header Branding -->
  <g transform="translate(100, 100)">
    <text font-family="system-ui, -apple-system, sans-serif" font-size="24" font-weight="700" fill="#f5c542" letter-spacing="1">ANYMEX <tspan fill="#9ca3af" font-weight="400">DESK</tspan></text>
  </g>

  <!-- Status & Kind Badges -->
  <g transform="translate(100, 150)">
    <!-- Kind Badge -->
    <rect x="0" y="0" width="130" height="34" rx="6" fill="${kindColor}" fill-opacity="0.16" stroke="${kindColor}" stroke-width="1.5" />
    <text x="65" y="22" font-family="system-ui, sans-serif" font-size="14" font-weight="600" fill="${kindColor}" text-anchor="middle">${escapeXml(kindLabel.toUpperCase())}</text>

    <!-- Status Badge -->
    <rect x="145" y="0" width="140" height="34" rx="6" fill="${statusColor}" fill-opacity="0.16" stroke="${statusColor}" stroke-width="1.5" />
    <text x="215" y="22" font-family="system-ui, sans-serif" font-size="14" font-weight="600" fill="${statusColor}" text-anchor="middle">${escapeXml(statusLabel)}</text>
  </g>

  <!-- Report Title -->
  <g transform="translate(100, 240)">
    ${titleLines.map((line, idx) => `
      <text x="0" y="${idx * 60}" font-family="system-ui, -apple-system, sans-serif" font-size="44" font-weight="700" fill="#ffffff" letter-spacing="-0.5">${escapeXml(line)}</text>
    `).join('')}
  </g>

  <!-- Footer Meta -->
  <g transform="translate(100, 490)">
    <!-- Votes Pill -->
    <rect x="0" y="0" width="120" height="42" rx="8" fill="#2d2f38" stroke="#3e414c" stroke-width="1" />
    <text x="60" y="26" font-family="ui-monospace, monospace" font-size="16" font-weight="700" fill="#f5c542" text-anchor="middle">▲ ${report.votes} VOTES</text>

    <!-- Category -->
    <text x="140" y="26" font-family="system-ui, sans-serif" font-size="16" fill="#9ca3af">• Category: <tspan fill="#e5e7eb" font-weight="600">${escapeXml(categoryLabel)}</tspan></text>

    <!-- Platform -->
    <text x="400" y="26" font-family="system-ui, sans-serif" font-size="16" fill="#9ca3af">• Platform: <tspan fill="#e5e7eb" font-weight="600">${escapeXml(platformLabel)}</tspan></text>
  </g>
</svg>`;

  return new Response(svg, {
    status: 200,
    headers: {
      'content-type': 'image/svg+xml',
      'cache-control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
};
