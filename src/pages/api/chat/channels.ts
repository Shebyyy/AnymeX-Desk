import type { APIRoute } from 'astro';
import { db } from '../../../lib/db/client';
import { chatChannels } from '../../../lib/db/schema';
import { currentUser } from '../../../lib/auth';
import { levelOf, atLeast } from '../../../lib/staff';
import { asc } from 'drizzle-orm';

export const prerender = false;

export const DEFAULT_CHANNELS = [
  { id: 'general', name: 'general', description: 'General discussion about AnymeX & Desk', icon: 'message-square', isStaffOnly: false, position: 1 },
  { id: 'support', name: 'support-help', description: 'Ask questions, get help, or report urgent issues', icon: 'help-circle', isStaffOnly: false, position: 2 },
  { id: 'features', name: 'feature-ideas', description: 'Discuss upcoming suggestions and ideas', icon: 'sparkles', isStaffOnly: false, position: 3 },
  { id: 'staff', name: 'staff-lounge', description: 'Internal team and moderator chat', icon: 'shield', isStaffOnly: true, position: 4 },
];

export const GET: APIRoute = async (ctx) => {
  let isStaff = false;
  try {
    const user = await currentUser(ctx);
    isStaff = user ? atLeast(await levelOf(user.id), 'mod') : false;

    let channels = await db()
      .select()
      .from(chatChannels)
      .orderBy(asc(chatChannels.position));

    // If channels table is empty, auto-seed defaults so channel list is never empty
    if (channels.length === 0) {
      try {
        for (const ch of DEFAULT_CHANNELS) {
          await db().insert(chatChannels).values(ch).onConflictDoNothing();
        }
        channels = await db()
          .select()
          .from(chatChannels)
          .orderBy(asc(chatChannels.position));
      } catch (insertErr) {
        console.warn('[chat:channels] Could not auto-seed channels table:', insertErr);
        channels = [...DEFAULT_CHANNELS] as any;
      }
    }

    if (!isStaff) {
      channels = channels.filter((c) => !c.isStaffOnly);
    }

    return new Response(JSON.stringify({ ok: true, channels }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[chat:channels] Error loading channels:', err);
    // Graceful fallback to default channels filtered by staff status
    const fallback = DEFAULT_CHANNELS.filter((c) => isStaff || !c.isStaffOnly);
    return new Response(JSON.stringify({ ok: true, channels: fallback }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
