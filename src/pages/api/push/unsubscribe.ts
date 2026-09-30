import type { APIRoute } from 'astro';
import { db } from '../../../lib/db/client';
import { pushSubscriptions } from '../../../lib/db/schema';
import { currentUser } from '../../../lib/auth';
import { eq } from 'drizzle-orm';

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
    const { endpoint } = body || {};

    if (endpoint) {
      await db()
        .delete(pushSubscriptions)
        .where(eq(pushSubscriptions.endpoint, endpoint));
    } else {
      await db()
        .delete(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, user.id));
    }

    return new Response(JSON.stringify({ ok: true, message: 'Unsubscribed from push notifications' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[push:unsubscribe] Error removing subscription:', err);
    return new Response(JSON.stringify({ ok: false, error: 'Internal Server Error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
