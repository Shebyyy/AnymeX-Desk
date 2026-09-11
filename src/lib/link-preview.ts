import { env } from 'cloudflare:workers';

/**
 * Rich preview cards for plain links pasted into comments — the same idea
 * as Discord's own link embeds: read the target page's Open Graph tags
 * (og:title, og:description, og:image) and show a small card instead of a
 * bare URL. Results are cached in KV so the same link isn't re-fetched on
 * every page view; failures are cached too, for a shorter time, so a dead
 * or slow link doesn't get hit again on every load.
 */

export interface LinkPreview {
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
}

const CACHE_OK_TTL = 60 * 60 * 24 * 30; // 30 days
const MEMORY_TTL_MS = 60 * 60 * 2 * 1000; // 2 hours in isolate memory
const FETCH_TIMEOUT_MS = 3000;
const MAX_BYTES = 60_000; // head metadata is always near the top of the document

// In-memory cache to prevent repetitive KV reads and writes within the same worker isolate
const memoryCache = new Map<string, { preview: LinkPreview | null; expiry: number }>();

// Blocks the obvious SSRF targets: localhost, loopback, link-local, and the
// private IPv4 ranges. Not exhaustive DNS-rebinding protection, but stops a
// pasted link from reaching internal services or cloud metadata endpoints.
const PRIVATE_HOST_RE =
  /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[?::1\]?|\[?fc00:|\[?fe80:)/i;

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function pickMeta(html: string, prop: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:${prop}["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']twitter:${prop}["'][^>]*content=["']([^"']*)["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

export async function fetchLinkPreview(url: string): Promise<LinkPreview | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (PRIVATE_HOST_RE.test(parsed.hostname)) return null;

  // Tier 1: Check in-memory isolate cache
  const now = Date.now();
  const memCached = memoryCache.get(url);
  if (memCached && memCached.expiry > now) {
    return memCached.preview;
  }

  const kv = env.SESSION as KVNamespace | undefined;
  const cacheKey = `ogcache:${await sha256Hex(url)}`;

  // Tier 2: Check KV cache
  if (kv) {
    try {
      const cached = await kv.get<LinkPreview>(cacheKey, 'json');
      if (cached) {
        memoryCache.set(url, { preview: cached, expiry: now + MEMORY_TTL_MS });
        return cached;
      }
    } catch {}
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; AnymeXDeskBot/1.0; +https://anymex-desk.asheby.workers.dev)',
        accept: 'text/html',
      },
    });
    clearTimeout(timer);

    if (!res.ok) throw new Error(`status ${res.status}`);
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) throw new Error('not html');

    let html = '';
    const reader = res.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      let received = 0;
      while (received < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
        received += value.byteLength;
      }
      reader.cancel().catch(() => {});
    }

    const titleFallback = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ?? null;
    let image = pickMeta(html, 'image');
    if (image && !/^https?:\/\//i.test(image)) {
      try {
        image = new URL(image, parsed).toString();
      } catch {
        image = null;
      }
    }

    const preview: LinkPreview = {
      title: pickMeta(html, 'title') ?? titleFallback,
      description: pickMeta(html, 'description'),
      image,
      siteName: pickMeta(html, 'site_name') ?? parsed.hostname,
    };

    if (!preview.title && !preview.image && !preview.description) throw new Error('no metadata');

    // Cache successful preview in memory and KV (30-day TTL)
    memoryCache.set(url, { preview, expiry: now + MEMORY_TTL_MS });
    if (kv) {
      try {
        await kv.put(cacheKey, JSON.stringify(preview), { expirationTtl: CACHE_OK_TTL });
      } catch {}
    }
    return preview;
  } catch {
    // DO NOT write failures to KV (saves KV daily write limit) — only cache in memory
    memoryCache.set(url, { preview: null, expiry: now + 1000 * 60 * 30 }); // 30 mins in memory
    return null;
  }
}

/** Fetch previews for several URLs in parallel, returning a URL → preview map (skipping nulls). */
export async function fetchLinkPreviews(urls: string[]): Promise<Map<string, LinkPreview>> {
  const unique = [...new Set(urls)];
  const results = await Promise.all(unique.map((u) => fetchLinkPreview(u)));
  const map = new Map<string, LinkPreview>();
  unique.forEach((u, i) => {
    const r = results[i];
    if (r) map.set(u, r);
  });
  return map;
}
