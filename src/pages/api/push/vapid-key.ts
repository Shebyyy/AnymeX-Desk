import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { DEFAULT_VAPID_PUBLIC } from '../../../lib/webpush';

export const prerender = false;

export const GET: APIRoute = async () => {
  try {
    const publicKey = (env as any)?.PUBLIC_VAPID_KEY || DEFAULT_VAPID_PUBLIC;
    return new Response(JSON.stringify({ ok: true, publicKey }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (err) {
    console.error('Error serving VAPID key, using fallback:', err);
    return new Response(JSON.stringify({ ok: true, publicKey: DEFAULT_VAPID_PUBLIC }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
