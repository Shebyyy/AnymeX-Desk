import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { currentUser } from '../../../lib/auth';
import { levelOf, atLeast } from '../../../lib/staff';

export const prerender = false;

/**
 * WebSocket upgrade. This is the only Worker request a client makes for
 * realtime — after it, events flow over the socket. Anonymous visitors may
 * connect (read-only: they receive change events but can't send typing).
 */
export const GET: APIRoute = async (ctx) => {
  if (ctx.request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 });
  }
  const ns = (env as any).CHAT_HUB as DurableObjectNamespace | undefined;
  if (!ns) return new Response('Realtime unavailable', { status: 503 });

  const user = await currentUser(ctx);
  const isStaff = user ? atLeast(await levelOf(user.id), 'mod') : false;

  const headers = new Headers(ctx.request.headers);
  // Overwrite so clients can't spoof identity.
  headers.set('x-chat-user-id', user?.id ?? '');
  headers.set('x-chat-username', user?.username ?? '');
  headers.set('x-chat-staff', isStaff ? '1' : '0');

  const stub = ns.get(ns.idFromName('global'));
  return stub.fetch(new Request(ctx.request.url, { headers }));
};
