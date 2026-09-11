/**
 * Service Worker registration for PWA installability and offline support.
 */
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                console.debug('[PWA] Updated service worker ready.');
              }
            });
          }
        });
      })
      .catch((err) => {
        console.debug('[PWA] Service worker registration error:', err);
      });
  });
}
