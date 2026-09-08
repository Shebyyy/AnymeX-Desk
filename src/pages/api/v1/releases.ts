import type { APIRoute } from 'astro';
import { getCachedReleases } from '../../../lib/github-releases';

export const prerender = false;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=60, s-maxage=300',
    },
  });
}

/**
 * GET /api/v1/releases
 *
 * Returns cached release versions for AnymeX Stable, Beta, and Extension Runtime Bridge.
 */
export const GET: APIRoute = async (ctx) => {
  const env = (ctx.locals.runtime?.env ?? (process as any).env) as { SESSION?: KVNamespace };
  const kv = env.SESSION as KVNamespace | undefined;

  try {
    const releases = await getCachedReleases(kv);
    return json(releases);
  } catch (err) {
    return json({ error: 'Failed to fetch releases' }, 500);
  }
};
