/**
 * Presence heartbeat for signed-in visitors.
 *
 * Goes over the shared realtime socket (no Worker request per heartbeat). If
 * the socket isn't up — or the hub can't match the user's row — it falls back
 * to POST /api/presence, which is what this used to do on every beat.
 *
 * Bundled (not inline) so the CSP hashes it.
 */
import { rt } from './realtime';

const signedIn = typeof document !== 'undefined' && /(?:^|;\s*)signed_in=1(?:;|$)/.test(document.cookie);

function http() {
  fetch('/api/presence', {
    method: 'POST',
    headers: { Accept: 'application/json' },
    keepalive: true,
  }).catch(() => {});
}

if (signedIn) {
  rt.on((m) => {
    if (m.t === 'presence-miss') http();
  });
  // Marks the user online as soon as the socket is up.
  rt.onOpen(() => rt.send({ t: 'presence' }));
  rt.connect();

  function beat() {
    if (document.visibilityState !== 'visible') return;
    if (rt.isOpen()) rt.send({ t: 'presence' });
    else http();
  }

  // If the socket hasn't come up shortly after load, don't leave presence stale.
  setTimeout(() => {
    if (!rt.isOpen() && document.visibilityState === 'visible') http();
  }, 4000);

  // Online window is 5 minutes (lib/presence.ts); 150s keeps it comfortably fresh.
  setInterval(beat, 150000);
  window.addEventListener('focus', beat);
  document.addEventListener('visibilitychange', beat);
}
