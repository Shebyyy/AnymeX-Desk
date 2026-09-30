import type { APIRoute } from 'astro';
import { DEFAULT_VAPID_PUBLIC } from '../../../lib/webpush';

export const prerender = false;

export const GET: APIRoute = async (ctx) => {
  const env = ctx.locals.runtime?.env as any;
  const publicKey = env?.PUBLIC_VAPID_KEY || DEFAULT_VAPID_PUBLIC;
  return new Response(JSON.stringify({ publicKey }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
