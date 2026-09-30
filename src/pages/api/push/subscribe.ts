import type { APIRoute } from 'astro';
import { db } from '../../../lib/db/client';
import { pushSubscriptions } from '../../../lib/db/schema';
import { currentUser } from '../../../lib/auth';
import { sql } from 'drizzle-orm';

export const prerender = false;

export const POST: APIRoute = async (ctx) => {
  const user = await currentUser(ctx);
  if (!user) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await ctx.request.json();
    const { endpoint, keys } = body || {};

    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return new Response(JSON.stringify({ ok: false, error: 'Invalid subscription payload' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const userAgent = ctx.request.headers.get('user-agent') || 'Browser';

    await db()
      .insert(pushSubscriptions)
      .values({
        userId: user.id,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent: userAgent.slice(0, 200),
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          userId: user.id,
          p256dh: keys.p256dh,
          auth: keys.auth,
          userAgent: userAgent.slice(0, 200),
          lastUsedAt: sql`(unixepoch())`,
        },
      });

    return new Response(JSON.stringify({ ok: true, message: 'Subscribed to push notifications' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[push:subscribe] Error saving subscription:', err);
    return new Response(JSON.stringify({ ok: false, error: 'Internal Server Error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
