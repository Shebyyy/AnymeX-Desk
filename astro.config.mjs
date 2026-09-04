import { readFileSync } from 'node:fs';
import { defineConfig, fontProviders } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import svelte from '@astrojs/svelte';

/**
 * `bun run build` and `bun run deploy` set ASTRO_BUILD; `astro dev` does not.
 * The Vite cacheDir below already leans on this, and the session cookie needs
 * the same distinction for a different reason — see there.
 */
const built = !!process.env.ASTRO_BUILD;

// Single source of truth for session lifetime. Used for both the
// server-side KV ttl and the browser cookie's maxAge below — see the
// comment on `session` for why both are required.
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // one week

export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    // Keep local D1/KV state on disk between `astro dev` runs so seeded
    // test reports survive a restart.
    persistState: true,
    }),

  integrations: [
    svelte(),
    /**
     * The two head scripts, injected rather than inlined in the layout.
     *
     * `security.csp` below hashes scripts Astro knows about — bundled chunks,
     * client directives, and whatever is injected at `head-inline` or
     * `before-hydration`. It does not read the rendered HTML, so an `is:inline`
     * script in a layout gets no hash and is blocked by the very policy meant
     * to protect it, in production only. Going through injectScript is what
     * makes each hash follow its file.
     *
     * src/scripts/theme.js resolves the theme before first paint and wires the
     * toggle; src/scripts/session-hint.js sets the signed-in hint on <html>
     * before first paint, which the header's CSS reads to pick the right
     * label. Both have to be in the head and neither needs a bundle.
     */
    {
      name: 'anymex:inline-scripts',
      hooks: {
        'astro:config:setup': ({ injectScript }) => {
          for (const file of ['theme.js', 'session-hint.js']) {
            injectScript(
              'head-inline',
              readFileSync(new URL(`./src/scripts/${file}`, import.meta.url), 'utf8'),
            );
          }
        },
      },
    },
  ],

  vite: {
    /**
     * `astro build` and `astro dev` both default to node_modules/.vite, so a
     * build run while the dev server is up deletes the pre-bundled deps the dev
     * server is still holding references to — which surfaces as
     * "The file does not exist at .../deps_ssr/..." on the next request.
     * Giving the build its own cache directory keeps them out of each other's
     * way. `bun run build` sets ASTRO_BUILD.
     */
    cacheDir: built ? 'node_modules/.vite-build' : 'node_modules/.vite-dev',
  },

  /**
   * The adapter fills in the Cloudflare KV driver itself (binding SESSION) and
   * carries `cookie` and `ttl` through, so declaring these does not displace
   * it.
   */
  session: {
    /**
     * One week TTL. The ban flag and account-age threshold are re-read on
     * every write, so this mostly bounds how long a session cookie stays valid.
     *
     * Astro stamps the expiry when a key is written, so this is a hard cap
     * measured from sign-in rather than a sliding window.
     */
    ttl: SESSION_TTL_SECONDS,
    cookie: {
      /**
       * Without this, Astro's cookie config has no `maxAge`, which makes it
       * a browser session cookie: gone the moment the browser actually
       * closes, even though the server-side session (KV, bounded by `ttl`
       * above) is still valid. That mismatch is what caused close-and-reopen
       * to look like a logout. Keep this equal to `ttl` — a longer maxAge
       * would let the cookie outlive the KV entry, a shorter one would log
       * people out client-side before the server session actually expires.
       */
      maxAge: SESSION_TTL_SECONDS,
      /**
       * The `__Host-` prefix is a browser-enforced rule, not a hint: a cookie
       * whose name starts with it is only accepted when it is Secure, has
       * Path=/ and carries no Domain, and it is then locked to this exact
       * host. That is what stops anything on a sibling host from
       * planting a session id for a visitor to arrive here holding — the other
       * half of the fixation fix in src/pages/auth/callback.ts. Astro's
       * defaults already supply Path=/ and no Domain.
       *
       * Only when built, because the prefix's Secure requirement is absolute
       * and Astro marks the cookie Secure outside dev only. Keeping the prefix
       * in `astro dev` would mean the browser silently dropped the cookie on
       * http://localhost and every request looked signed out.
       *
       * Renaming the cookie invalidates every session issued under the old
       * name. Given what the old name allowed, one forced sign-in is the point
       * rather than a cost.
       */
      name: built ? '__Host-astro-session' : 'astro-session',
    },
  },

  /**
   * Hover, and no prefetchAll.
   *
   * The homepage carries many `/report/<id>` links, all server-rendered
   * with no cache headers. Under `prefetchAll` + 'viewport' every link
   * would be fetched 300ms after scrolling into view, costing many Worker
   * invocations and D1 round-trips for pages nobody opened.
   *
   * Prefetch stays enabled so individual links can opt in with
   * `data-astro-prefetch`.
   */
  prefetch: { defaultStrategy: 'hover' },
  devToolbar: { enabled: false },

  /**
   * Content-Security-Policy, computed at build time.
   *
   * Astro emits a `<meta http-equiv="content-security-policy">` per page and
   * fills in `script-src` and `style-src` with the SHA-256 hash of every inline
   * script and every scoped style it actually rendered. That is the whole
   * reason this is here rather than hand-written into public/_headers: the
   * layout carries inline scripts — the pre-paint theme resolver and the theme
   * toggle — and a hash pasted into a static file goes stale the first time
   * anyone edits one, at which point the site breaks silently in production and
   * nowhere else.
   *
   * `frame-ancestors` deliberately is *not* here: browsers ignore it in a
   * `<meta>` element, so it has to be a real response header. It lives in
   * public/_headers alongside HSTS and the rest, which are also header-only.
   *
   * img-src names Discord's CDN for user avatars; `data:` covers the
   * inline SVG favicon. Everything else is same-origin — fonts are
   * self-hosted through Workers Assets.
   */
  security: {
    csp: {
      directives: [
        "default-src 'self'",
        "img-src 'self' https://cdn.discordapp.com data:",
        "connect-src 'self'",
        "font-src 'self'",
        // Only ever posts to itself. Blocks an injected form from exfiltrating a
        // report — or a moderator's status change — to somewhere else.
        "form-action 'self'",
        "base-uri 'none'",
        "object-src 'none'",
      ],
    },
  },

  // Self-hosted through Workers Assets, so the font files come from this origin
  // and no runtime request reaches Google — which is the point for this
  // audience, and is what lets the CSP above say `font-src 'self'` and mean it.
  // An earlier version of this comment claimed the site shipped a strict CSP
  // while it shipped no security headers at all; the `security.csp` block above
  // and public/_headers are where that is now actually true.
  fonts: [
    {
      provider: fontProviders.google(),
      name: 'IBM Plex Sans',
      cssVariable: '--font-ui-family',
      weights: [400, 500, 600],
      styles: ['normal'],
      /**
       * `latin` only. Report text can contain any language; the system
       * fallback handles characters outside this subset.
       */
      subsets: ['latin'],
      fallbacks: ['system-ui', 'sans-serif'],
    },
    {
      provider: fontProviders.google(),
      name: 'IBM Plex Mono',
      cssVariable: '--font-data-family',
      // 500 stays for code and monospaced elements.
      weights: [400, 500, 600],
      styles: ['normal'],
      subsets: ['latin'],
      fallbacks: ['ui-monospace', 'monospace'],
    },
  ],
});
