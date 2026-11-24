import type { Driver } from 'unstorage';
import cloudflareKVBinding, { type KVOptions } from 'unstorage/drivers/cloudflare-kv-binding';

/**
 * Astro's Cloudflare KV session driver, with writes that cannot take the site
 * down.
 *
 * Astro persists the session in `finalize`, after the page has already been
 * rendered, and it lets a failed `setItem` propagate — so the moment Workers KV
 * starts returning 429 (the free tier allows 1,000 puts a day for the whole
 * account) every request that touched the session answers HTTP 500, including
 * pages that had rendered fine.
 *
 * Here a failed write is logged and dropped instead. The cost is small and
 * bounded: while KV is rejecting writes a new sign-in is not remembered (the
 * visitor lands signed out and can retry later) and a renewal is skipped. Pages,
 * and sessions that already exist, keep working because reads are unaffected.
 */
export default function resilientKVSessionDriver(opts: KVOptions): Driver {
  const inner = cloudflareKVBinding(opts);

  const swallow = (what: string, err: unknown) => {
    console.error(
      `[session] KV ${what} failed; continuing without persisting:`,
      err instanceof Error ? err.message : err,
    );
  };

  return {
    ...inner,
    name: 'resilient-cloudflare-kv-binding',
    async setItem(key, value, topts) {
      try {
        await inner.setItem?.(key, value, topts);
      } catch (err) {
        swallow('put', err);
      }
    },
    async setItemRaw(key, value, topts) {
      try {
        await inner.setItemRaw?.(key, value, topts);
      } catch (err) {
        swallow('put', err);
      }
    },
    async removeItem(key, topts) {
      try {
        await inner.removeItem?.(key, topts);
      } catch (err) {
        swallow('delete', err);
      }
    },
  };
}
