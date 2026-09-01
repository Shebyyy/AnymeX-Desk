import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';

export const prerender = false;

/*
 * Serves uploaded files stored in KV.
 * Key format: "upload:uploads/uuid/filename.ext"
 */
export const GET: APIRoute = async (ctx) => {
  // ctx.params.path is everything after /uploads/
  const filePath = `uploads/${ctx.params.path}`;
  const kvKey = `upload:${filePath}`;

  const kv = env.SESSION as KVNamespace | undefined;
  if (!kv) {
    return new Response('Storage not configured', { status: 503 });
  }

  const { value, metadata } = await kv.getWithMetadata(kvKey, { type: 'arrayBuffer' });

  if (!value) {
    return new Response('File not found', { status: 404 });
  }

  const mime = (metadata as any)?.mimeType ?? 'application/octet-stream';

  return new Response(value, {
    headers: {
      'content-type': mime,
      'cache-control': 'public, max-age=86400, immutable',
      // Allow embedding in our own pages.
      'x-content-type-options': 'nosniff',
    },
  });
};
