import { DurableObject } from 'cloudflare:workers';

/**
 * ChatHub — one global Durable Object that fans out realtime chat events over
 * hibernatable WebSockets.
 *
 * Why this exists: the chat used to poll the Worker every few seconds per open
 * tab, which burned the 100k/day free request limit. With WebSockets a client
 * costs ONE Worker request (the upgrade). Everything after that is free or
 * nearly so:
 *   - server -> client messages are not billed
 *   - client -> server messages (typing) are billed 20:1 as DO requests
 *   - hibernation: idle sockets don't keep the object in memory, so no
 *     duration charges while nobody is talking
 *
 * Events sent to clients (JSON):
 *   { t: 'changed',  channel }                    messages in channel changed -> refetch
 *   { t: 'channels' }                             channel list changed -> refetch
 *   { t: 'typing',   channel, userId, username }  someone is typing
 *   { t: 'report',   reportId }                   report comments/status/lock changed
 * Clients -> server:
 *   { t: 'join', channel?, reportId? }  what this socket is looking at
 *   { t: 'typing' }                      I'm typing in my joined channel
 *   { t: 'presence' }                    heartbeat; updates users.last_seen (replies
 *                                        { t: 'presence-miss' } if no row matched so
 *                                        the client can fall back to HTTP)
 */

interface Attachment {
  userId: string;
  username: string;
  telegramId: string;
  isStaff: boolean;
  channel: string | null;
  reportId: number | null;
  lastTyping: number;
  lastPresence: number;
}

export class ChatHub extends DurableObject<Env> {
  /** channelId -> isStaffOnly, cached briefly in memory (lost on hibernation, which is fine). */
  private staffOnly: Map<string, boolean> | null = null;
  private staffOnlyAt = 0;

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    const h = request.headers;
    const att: Attachment = {
      userId: h.get('x-chat-user-id') ?? '',
      username: h.get('x-chat-username') ?? '',
      telegramId: h.get('x-chat-tg') ?? '',
      isStaff: h.get('x-chat-staff') === '1',
      channel: null,
      reportId: null,
      lastTyping: 0,
      lastPresence: 0,
    };
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(att);
    // Answered by the runtime without waking the object.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** RPC: called by API routes after they write to D1. */
  async notify(event: { t: string; channel?: string | null; reportId?: number }): Promise<void> {
    const payload = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a) continue;
      if (event.t === 'changed' && event.channel && a.channel !== event.channel) continue;
      if (event.t === 'changed' && !event.channel && !a.channel) continue;
      if (event.t === 'report' && a.reportId !== event.reportId) continue;
      try {
        ws.send(payload);
      } catch {}
    }
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string' || raw.length > 512) return;
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!a) return;

    if (msg.t === 'join') {
      if (msg.channel === null) a.channel = null;
      if (typeof msg.channel === 'string') {
        const ch = msg.channel.slice(0, 64);
        // Never subscribe a non-staff socket to a staff-only channel.
        if (!a.isStaff && (await this.isStaffOnly(ch))) {
          a.channel = null;
        } else {
          a.channel = ch;
        }
      }
      if (typeof msg.reportId === 'number' && Number.isFinite(msg.reportId)) {
        a.reportId = msg.reportId;
      }
      ws.serializeAttachment(a);
      return;
    }

    if (msg.t === 'presence') {
      if (!a.userId) return;
      const now = Date.now();
      if (now - a.lastPresence < 60_000) return; // at most one D1 write/min per socket
      a.lastPresence = now;
      ws.serializeAttachment(a);
      try {
        const res = await this.env.DB.prepare(
          "UPDATE users SET last_seen = unixepoch() WHERE discord_id = ?1 OR (?2 != '' AND telegram_id = ?2)",
        )
          .bind(a.userId, a.telegramId)
          .run();
        if (!res.meta?.changes) ws.send(JSON.stringify({ t: 'presence-miss' }));
      } catch {
        try { ws.send(JSON.stringify({ t: 'presence-miss' })); } catch {}
      }
      return;
    }

    if (msg.t === 'typing' && a.channel && a.userId) {
      const now = Date.now();
      if (now - a.lastTyping < 2000) return; // server-side throttle
      a.lastTyping = now;
      ws.serializeAttachment(a);
      const payload = JSON.stringify({
        t: 'typing',
        channel: a.channel,
        userId: a.userId,
        username: a.username,
      });
      for (const other of this.ctx.getWebSockets()) {
        if (other === ws) continue;
        const o = other.deserializeAttachment() as Attachment | null;
        if (o?.channel === a.channel) {
          try {
            other.send(payload);
          } catch {}
        }
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {}
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011);
    } catch {}
  }

  private async isStaffOnly(channelId: string): Promise<boolean> {
    const now = Date.now();
    if (!this.staffOnly || now - this.staffOnlyAt > 60_000) {
      try {
        const { results } = await this.env.DB.prepare(
          'SELECT id, is_staff_only AS s FROM chat_channels',
        ).all<{ id: string; s: number }>();
        this.staffOnly = new Map(results.map((r) => [r.id, !!r.s]));
        this.staffOnlyAt = now;
      } catch {
        // If we can't tell, fail closed for anything we don't already know.
        return this.staffOnly?.get(channelId) ?? true;
      }
    }
    return this.staffOnly!.get(channelId) ?? false;
  }
}
