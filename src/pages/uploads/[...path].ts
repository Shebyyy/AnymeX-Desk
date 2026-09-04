import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';

export const prerender = false;

/*
 * Serves uploaded files stored in KV.
 * Key format: "upload:uploads/uuid/filename.ext"
 *
 * If the KV value is missing but a discord_cdn_url was stored for this path,
 * we 302-redirect to the Discord CDN URL directly. This handles attachments
 * that came from Discord and were never uploaded to KV.
 */
export const GET: APIRoute = async (ctx) => {
  let subpath = ctx.params.path || '';
  while (subpath.startsWith('uploads/')) {
    subpath = subpath.slice('uploads/'.length);
  }
  const filePath = `uploads/${subpath}`;
  const kvKey = `upload:${filePath}`;

  const kv = env.SESSION as KVNamespace | undefined;
  if (!kv) {
    return new Response('Storage not configured', { status: 503 });
  }

  const { value, metadata } = await kv.getWithMetadata(kvKey, { type: 'arrayBuffer' });

  if (value) {
    const mime = (metadata as any)?.mimeType ?? 'application/octet-stream';
    return new Response(value, {
      headers: {
        'content-type': mime,
        'cache-control': 'public, max-age=86400, immutable',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  // Check if there's a Discord CDN URL stored for this path
  const cdnUrlKey = `discord_cdn:${filePath}`;
  const cdnUrl = await kv.get(cdnUrlKey);
  if (cdnUrl) {
    // Redirect to Discord CDN — the browser fetches the file directly
    return new Response(null, {
      status: 302,
      headers: { Location: cdnUrl },
    });
  }

  return new Response('File not found', { status: 404 });
};
