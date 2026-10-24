import { env } from 'cloudflare:workers';

/**
 * Tell connected WebSocket clients that something changed. Best-effort: a hub
 * failure must never fail the write that triggered it, and clients still
 * resync on reconnect / tab focus.
 */
function hub() {
  const ns = (env as any).CHAT_HUB as DurableObjectNamespace | undefined;
  if (!ns) return null;
  return ns.get(ns.idFromName('global')) as any;
}

export async function notifyChat(channel: string | null): Promise<void> {
  try {
    await hub()?.notify({ t: 'changed', channel });
  } catch (e) {
    console.warn('[chat-hub] notify failed', e);
  }
}

export async function notifyChannels(): Promise<void> {
  try {
    await hub()?.notify({ t: 'channels' });
  } catch {}
}

export async function notifyReport(reportId: number): Promise<void> {
  try {
    await hub()?.notify({ t: 'report', reportId });
  } catch {}
}
