/**
 * GitHub Releases Fetcher & Cache for AnymeX
 *
 * Fetches and caches releases from:
 * - https://github.com/RyanYuuki/AnymeX (Stable)
 * - https://github.com/Shebyyy/AnymeX-Preview (Beta)
 * - https://github.com/RyanYuuki/AnymeXExtensionRuntimeBridge (Plugin Bridge)
 *
 * Caches in Cloudflare KV (SESSION namespace) with 15-minute TTL,
 * backed by in-memory isolate cache and graceful hardcoded fallbacks.
 */

export interface ReleaseVersionItem {
  tag: string;
  version: string;
  name: string;
  publishedAt: string;
  channel?: 'stable' | 'beta';
  isLatest?: boolean;
  url: string;
}

export interface ReleasesPayload {
  stable: ReleaseVersionItem[];
  beta: ReleaseVersionItem[];
  plugin: ReleaseVersionItem[];
  latest: {
    stable: ReleaseVersionItem | null;
    beta: ReleaseVersionItem | null;
    plugin: ReleaseVersionItem | null;
  };
  cachedAt: number;
}

// Built-in fallbacks if GitHub API is unreachable and KV is empty
const FALLBACK_STABLE: ReleaseVersionItem[] = [
  { tag: 'v3.1.7', version: '3.1.7', name: 'v3.1.7', publishedAt: '2026-08-30T18:46:47Z', channel: 'stable', isLatest: true, url: 'https://github.com/RyanYuuki/AnymeX/releases/tag/v3.1.7' },
  { tag: 'v3.1.6', version: '3.1.6', name: 'v3.1.6', publishedAt: '2026-08-16T17:11:54Z', channel: 'stable', isLatest: false, url: 'https://github.com/RyanYuuki/AnymeX/releases/tag/v3.1.6' },
  { tag: 'v3.1.5', version: '3.1.5', name: 'v3.1.5', publishedAt: '2026-08-01T12:00:00Z', channel: 'stable', isLatest: false, url: 'https://github.com/RyanYuuki/AnymeX/releases/tag/v3.1.5' },
];

const FALLBACK_BETA: ReleaseVersionItem[] = [
  { tag: 'v3.1.6+4-beta', version: '3.1.6+4-beta', name: 'v3.1.6+4-beta', publishedAt: '2026-08-30T09:15:16Z', channel: 'beta', isLatest: true, url: 'https://github.com/Shebyyy/AnymeX-Preview/releases/tag/v3.1.6%2B4-beta' },
  { tag: 'v3.1.6+3-beta', version: '3.1.6+3-beta', name: 'v3.1.6+3-beta', publishedAt: '2026-08-28T19:13:04Z', channel: 'beta', isLatest: false, url: 'https://github.com/Shebyyy/AnymeX-Preview/releases/tag/v3.1.6%2B3-beta' },
  { tag: 'v3.1.6+2-beta', version: '3.1.6+2-beta', name: 'v3.1.6+2-beta', publishedAt: '2026-08-25T18:21:38Z', channel: 'beta', isLatest: false, url: 'https://github.com/Shebyyy/AnymeX-Preview/releases/tag/v3.1.6%2B2-beta' },
];

const FALLBACK_PLUGIN: ReleaseVersionItem[] = [
  { tag: 'v2.4.0', version: '2.4.0', name: 'v2.4.0', publishedAt: '2026-09-03T18:02:15Z', isLatest: true, url: 'https://github.com/RyanYuuki/AnymeXExtensionRuntimeBridge/releases/tag/v2.4.0' },
  { tag: 'v2.3.0', version: '2.3.0', name: 'v2.3.0', publishedAt: '2026-08-09T16:37:59Z', isLatest: false, url: 'https://github.com/RyanYuuki/AnymeXExtensionRuntimeBridge/releases/tag/v2.3.0' },
  { tag: 'v2.2.0', version: '2.2.0', name: 'v2.2.0', publishedAt: '2026-08-03T16:42:06Z', isLatest: false, url: 'https://github.com/RyanYuuki/AnymeXExtensionRuntimeBridge/releases/tag/v2.2.0' },
];

export const FALLBACK_RELEASES: ReleasesPayload = {
  stable: FALLBACK_STABLE,
  beta: FALLBACK_BETA,
  plugin: FALLBACK_PLUGIN,
  latest: {
    stable: FALLBACK_STABLE[0] ?? null,
    beta: FALLBACK_BETA[0] ?? null,
    plugin: FALLBACK_PLUGIN[0] ?? null,
  },
  cachedAt: 0,
};

const KV_CACHE_KEY = 'gh_releases:all:v1';
const CACHE_TTL_SECONDS = 900; // 15 minutes
const MEMORY_TTL_MS = 300_000; // 5 minutes in worker memory

let inMemoryCache: { data: ReleasesPayload; expiry: number } | null = null;

function normalizeTagVersion(tag: string): string {
  return tag.replace(/^[vV]/, '').trim();
}

async function fetchRepoReleases(repo: string, channel?: 'stable' | 'beta'): Promise<ReleaseVersionItem[]> {
  const url = `https://api.github.com/repos/${repo}/releases?per_page=15`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'AnymeXDesk-Releases/1.0 (+https://anymex-desk.asheby.workers.dev)',
        accept: 'application/vnd.github.v3+json',
      },
    });
    clearTimeout(timer);

    if (!res.ok) {
      return [];
    }

    const json = (await res.json()) as Array<{
      tag_name: string;
      name: string;
      published_at: string;
      html_url: string;
      draft: boolean;
    }>;

    if (!Array.isArray(json)) return [];

    return json
      .filter((r) => !r.draft && r.tag_name)
      .map((r, i) => ({
        tag: r.tag_name,
        version: normalizeTagVersion(r.tag_name),
        name: r.name || r.tag_name,
        publishedAt: r.published_at,
        channel,
        isLatest: i === 0,
        url: r.html_url,
      }));
  } catch {
    clearTimeout(timer);
    return [];
  }
}

/**
 * Fetch all releases with multi-tier caching (Memory -> KV -> GitHub API -> Fallback).
 */
export async function getCachedReleases(kv?: KVNamespace | null): Promise<ReleasesPayload> {
  const now = Date.now();

  // Tier 1: Check memory cache
  if (inMemoryCache && inMemoryCache.expiry > now) {
    return inMemoryCache.data;
  }

  // Tier 2: Check KV cache
  if (kv) {
    try {
      const cached = await kv.get<ReleasesPayload>(KV_CACHE_KEY, 'json');
      if (cached && cached.stable?.length > 0) {
        inMemoryCache = { data: cached, expiry: now + MEMORY_TTL_MS };
        return cached;
      }
    } catch {
      // Ignore KV error and proceed to fetch
    }
  }

  // Tier 3: Fetch fresh releases from GitHub
  try {
    const [stable, beta, plugin] = await Promise.all([
      fetchRepoReleases('RyanYuuki/AnymeX', 'stable'),
      fetchRepoReleases('Shebyyy/AnymeX-Preview', 'beta'),
      fetchRepoReleases('RyanYuuki/AnymeXExtensionRuntimeBridge'),
    ]);

    const resultStable = stable.length > 0 ? stable : FALLBACK_STABLE;
    const resultBeta = beta.length > 0 ? beta : FALLBACK_BETA;
    const resultPlugin = plugin.length > 0 ? plugin : FALLBACK_PLUGIN;

    const payload: ReleasesPayload = {
      stable: resultStable,
      beta: resultBeta,
      plugin: resultPlugin,
      latest: {
        stable: resultStable[0] ?? null,
        beta: resultBeta[0] ?? null,
        plugin: resultPlugin[0] ?? null,
      },
      cachedAt: now,
    };

    // Store in memory
    inMemoryCache = { data: payload, expiry: now + MEMORY_TTL_MS };

    // Store in KV
    if (kv) {
      try {
        await kv.put(KV_CACHE_KEY, JSON.stringify(payload), { expirationTtl: CACHE_TTL_SECONDS });
      } catch {
        // KV put error is non-fatal
      }
    }

    return payload;
  } catch {
    return FALLBACK_RELEASES;
  }
}
