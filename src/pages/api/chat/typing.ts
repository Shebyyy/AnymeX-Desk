import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { currentUser } from '../../../lib/auth';

export const prerender = false;

interface TypingRecord {
  username: string;
  expiresAt: number;
}

export const POST: APIRoute = async (ctx) => {
  try {
    const user = await currentUser(ctx);
    if (!user) {
      return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = await ctx.request.json().catch(() => ({}));
    const channelId = typeof body.channelId === 'string' && body.channelId.trim() ? body.channelId.trim() : 'general';

    const kv = (env as any).SESSION as KVNamespace | undefined;
    if (kv) {
      const key = `chat_typing:${channelId}`;
      let map: Record<string, TypingRecord> = {};
      try {
        const raw = await kv.get(key);
        if (raw) map = JSON.parse(raw);
      } catch {}

      const now = Date.now();
      // Purge expired typers
      for (const uid of Object.keys(map)) {
        if (!map[uid] || map[uid].expiresAt < now) {
          delete map[uid];
        }
      }

      // Register or update current user typing status (expires in 4.5 seconds)
      map[user.id] = {
        username: user.username,
        expiresAt: now + 4500,
      };

      await kv.put(key, JSON.stringify(map), { expirationTtl: 60 });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err?.message || 'Server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const GET: APIRoute = async (ctx) => {
  try {
    const user = await currentUser(ctx);
    const url = new URL(ctx.request.url);
    const channelId = url.searchParams.get('channel') || 'general';

    const kv = (env as any).SESSION as KVNamespace | undefined;
    const typingUsers: { userId: string; username: string }[] = [];

    if (kv) {
      const raw = await kv.get(`chat_typing:${channelId}`);
      if (raw) {
        try {
          const map = JSON.parse(raw) as Record<string, TypingRecord>;
          const now = Date.now();
          for (const [uid, item] of Object.entries(map)) {
            if (item && item.expiresAt > now && uid !== user?.id) {
              typingUsers.push({ userId: uid, username: item.username });
            }
          }
        } catch {}
      }
    }

    return new Response(JSON.stringify({ ok: true, typingUsers }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ ok: false, error: err?.message || 'Server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
