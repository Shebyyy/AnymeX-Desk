import { defineMiddleware } from 'astro:middleware';

/**
 * Security headers on server-rendered responses.
 */
const HEADERS: Record<string, string> = {
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
};

export const onRequest = defineMiddleware(async (_ctx, next) => {
  const res = await next();
  try {
    for (const [name, value] of Object.entries(HEADERS)) res.headers.set(name, value);
    return res;
  } catch {
    const copy = new Response(res.body, res);
    for (const [name, value] of Object.entries(HEADERS)) copy.headers.set(name, value);
    return copy;
  }
});
