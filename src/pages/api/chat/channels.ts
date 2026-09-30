import type { APIRoute } from 'astro';
import { db } from '../../../lib/db/client';
import { chatChannels } from '../../../lib/db/schema';
import { currentUser } from '../../../lib/auth';
import { levelOf, atLeast } from '../../../lib/staff';
import { asc } from 'drizzle-orm';

export const prerender = false;

export const GET: APIRoute = async (ctx) => {
  try {
    const user = await currentUser(ctx);
    const isStaff = user ? atLeast(await levelOf(user.id), 'mod') : false;

    let channels = await db()
      .select()
      .from(chatChannels)
      .orderBy(asc(chatChannels.position));

    if (!isStaff) {
      channels = channels.filter((c) => !c.isStaffOnly);
    }

    return new Response(JSON.stringify({ ok: true, channels }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[chat:channels] Error loading channels:', err);
    return new Response(JSON.stringify({ ok: false, error: 'Internal Server Error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
