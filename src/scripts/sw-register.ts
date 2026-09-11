/**
 * Service Worker registration, PWA install prompt, and smart floating banner handler.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;

const BANNER_DISMISSED_KEY = 'anymex_pwa_banner_dismissed_at';
const BANNER_COUNT_KEY = 'anymex_pwa_banner_dismiss_count';
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function isAppStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent.toLowerCase();
  return /iphone|ipad|ipod/.test(ua) && !(window as unknown as { MSStream?: unknown }).MSStream;
}

function updateInstallButtons(show: boolean) {
  const desktopBtn = document.getElementById('pwa-install-btn');
  const mobileBtn = document.getElementById('pwa-mobile-install-btn');

  if (desktopBtn) {
    desktopBtn.style.display = show ? 'inline-flex' : 'none';
  }
  if (mobileBtn) {
    mobileBtn.style.display = show ? 'block' : 'none';
  }
}

function showIosInstructions() {
  let modal = document.getElementById('pwa-ios-modal') as HTMLDialogElement | null;
  if (!modal) {
    modal = document.createElement('dialog');
    modal.id = 'pwa-ios-modal';
    modal.className = 'pwa-ios-dialog';
    modal.innerHTML = `
      <div class="pwa-ios-window">
        <header class="pwa-ios-head">
          <div class="pwa-ios-brand">
            <img src="/icons/icon-192.png" width="36" height="36" alt="AnymeX Desk" style="border-radius: 8px;" />
            <div>
              <h3>Install AnymeX Desk</h3>
              <p>Add to Home Screen for the full app experience</p>
            </div>
          </div>
          <button type="button" class="pwa-ios-close" aria-label="Close">×</button>
        </header>
        <div class="pwa-ios-body">
          <div class="pwa-ios-step">
            <div class="pwa-step-num">1</div>
            <div>Tap the <strong>Share</strong> button <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; display: inline-block;"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg> at the bottom of Safari.</div>
          </div>
          <div class="pwa-ios-step">
            <div class="pwa-step-num">2</div>
            <div>Scroll down and select <strong>Add to Home Screen</strong> <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; display: inline-block;"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8"/><path d="M8 12h8"/></svg>.</div>
          </div>
        </div>
        <div class="pwa-ios-foot">
          <button type="button" class="btn btn-primary btn-sm pwa-ios-done-btn">Got it</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const closeBtn = modal.querySelector('.pwa-ios-close');
    const doneBtn = modal.querySelector('.pwa-ios-done-btn');
    const close = () => modal?.close();
    closeBtn?.addEventListener('click', close);
    doneBtn?.addEventListener('click', close);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.close();
    });
  }

  modal.showModal();
}

function handleInstallTrigger() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then((choice) => {
      if (choice.outcome === 'accepted') {
        updateInstallButtons(false);
        dismissBanner(true);
      }
      deferredPrompt = null;
    });
  } else if (isIos()) {
    showIosInstructions();
  }
}

function shouldShowBanner(): boolean {
  if (isAppStandalone()) return false;

  try {
    const count = parseInt(localStorage.getItem(BANNER_COUNT_KEY) || '0', 10);
    if (count >= 2) return false;

    const lastDismissed = parseInt(localStorage.getItem(BANNER_DISMISSED_KEY) || '0', 10);
    if (lastDismissed && Date.now() - lastDismissed < SNOOZE_MS) {
      return false;
    }
  } catch {}

  return true;
}

function dismissBanner(permanent = false) {
  const banner = document.getElementById('pwa-install-banner');
  if (banner) {
    banner.style.display = 'none';
  }
  try {
    localStorage.setItem(BANNER_DISMISSED_KEY, Date.now().toString());
    const count = parseInt(localStorage.getItem(BANNER_COUNT_KEY) || '0', 10);
    localStorage.setItem(BANNER_COUNT_KEY, permanent ? '99' : (count + 1).toString());
  } catch {}
}

function showBanner() {
  if (!shouldShowBanner()) return;
  const banner = document.getElementById('pwa-install-banner');
  if (banner) {
    banner.style.display = 'flex';
  }
}

function initBanner() {
  const banner = document.getElementById('pwa-install-banner');
  if (!banner) return;

  const installBtn = document.getElementById('pwa-banner-install-btn');
  const dismissBtn = document.getElementById('pwa-banner-dismiss-btn');
  const closeBtn = document.getElementById('pwa-banner-close-btn');

  if (installBtn && !installBtn.hasAttribute('data-bound')) {
    installBtn.setAttribute('data-bound', 'true');
    installBtn.addEventListener('click', () => {
      dismissBanner();
      handleInstallTrigger();
    });
  }

  if (dismissBtn && !dismissBtn.hasAttribute('data-bound')) {
    dismissBtn.setAttribute('data-bound', 'true');
    dismissBtn.addEventListener('click', () => dismissBanner(false));
  }

  if (closeBtn && !closeBtn.hasAttribute('data-bound')) {
    closeBtn.setAttribute('data-bound', 'true');
    closeBtn.addEventListener('click', () => dismissBanner(false));
  }

  // 10-second delay on page load before presenting the floating banner
  setTimeout(() => {
    if (deferredPrompt || isIos()) {
      showBanner();
    }
  }, 10000);
}

// Wire up click handlers
function initInstallButtons() {
  const desktopBtn = document.getElementById('pwa-install-btn');
  const mobileBtn = document.getElementById('pwa-mobile-install-btn');

  if (desktopBtn && !desktopBtn.hasAttribute('data-pwa-bound')) {
    desktopBtn.setAttribute('data-pwa-bound', 'true');
    desktopBtn.addEventListener('click', handleInstallTrigger);
  }
  if (mobileBtn && !mobileBtn.hasAttribute('data-pwa-bound')) {
    mobileBtn.setAttribute('data-pwa-bound', 'true');
    mobileBtn.addEventListener('click', handleInstallTrigger);
  }

  initBanner();

  if (isAppStandalone()) {
    updateInstallButtons(false);
    return;
  }

  if (isIos()) {
    updateInstallButtons(true);
  }
}

// Capture Chrome / Edge / Android install prompt
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e as BeforeInstallPromptEvent;
  if (!isAppStandalone()) {
    updateInstallButtons(true);
  }
});

// App was installed
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  updateInstallButtons(false);
  dismissBanner(true);
  console.debug('[PWA] AnymeX Desk installed');
});

// Service Worker Registration
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    initInstallButtons();

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
