/**
 * Shared realtime socket — one WebSocket per tab to the ChatHub Durable Object.
 *
 * Everything that wants live events (presence heartbeat, chat, report pages)
 * goes through this singleton, so a tab holds at most ONE socket no matter how
 * many features use it. Connecting costs one Worker request; after that,
 * traffic over the socket costs no Worker requests.
 *
 * Reconnects with backoff, stops hammering the server after repeated failures
 * (callers keep working through their own slow HTTP fallbacks), and retries
 * when the tab becomes visible again.
 */

type Msg = Record<string, any>;

const MAX_FAILURES = 6;

let ws: WebSocket | null = null;
let open = false;
let wanted = false;
let delay = 1000;
let failures = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const msgListeners = new Set<(m: Msg) => void>();
const openListeners = new Set<() => void>();

function schedule() {
  if (!wanted || reconnectTimer) return;
  if (failures >= MAX_FAILURES) return; // give up until the tab is shown again / reload
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!document.hidden) connect();
  }, delay);
  delay = Math.min(delay * 2, 120000);
}

function connect() {
  if (typeof window === 'undefined') return;
  wanted = true;
  if (ws) return;
  let sock: WebSocket;
  try {
    sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/chat/ws`);
  } catch {
    failures++;
    schedule();
    return;
  }
  ws = sock;
  sock.onopen = () => {
    open = true;
    delay = 1000;
    failures = 0;
    for (const f of [...openListeners]) {
      try { f(); } catch {}
    }
  };
  sock.onmessage = (e) => {
    if (e.data === 'pong') return;
    let m: Msg;
    try { m = JSON.parse(e.data); } catch { return; }
    for (const f of [...msgListeners]) {
      try { f(m); } catch {}
    }
  };
  sock.onclose = () => {
    if (!open) failures++; // never got established
    open = false;
    ws = null;
    schedule();
  };
  sock.onerror = () => {
    try { sock.close(); } catch {}
  };
}

if (typeof window !== 'undefined') {
  // Retry as soon as the tab is shown again (laptop woke up, user came back).
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !wanted || ws) return;
    failures = Math.min(failures, MAX_FAILURES - 2);
    delay = 1000;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connect();
  });
  // Keepalive for the connection while visible; the runtime answers it
  // without waking the Durable Object.
  setInterval(() => {
    if (!document.hidden && ws && open) {
      try { ws.send('ping'); } catch {}
    }
  }, 45000);
}

export const rt = {
  connect,
  isOpen: () => open,
  send(obj: unknown) {
    if (ws && open) {
      try { ws.send(JSON.stringify(obj)); } catch {}
    }
  },
  /** Subscribe to every message. Returns an unsubscribe function. */
  on(fn: (m: Msg) => void) {
    msgListeners.add(fn);
    return () => { msgListeners.delete(fn); };
  },
  /** Runs on every (re)connect, and immediately if already connected. */
  onOpen(fn: () => void) {
    openListeners.add(fn);
    if (open) {
      try { fn(); } catch {}
    }
    return () => { openListeners.delete(fn); };
  },
};
