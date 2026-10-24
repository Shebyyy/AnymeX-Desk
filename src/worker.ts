/**
 * Worker entry (wrangler `main`). Delegates HTTP to Astro's handler and
 * exports the Durable Object class + cron handler so Cloudflare can find them.
 */
import astro from '@astrojs/cloudflare/entrypoints/server';
import { onScheduled } from './pages/api/discord/poll';

export { ChatHub } from './durable/chat-hub';

export default {
  fetch: astro.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(onScheduled(event, env));
  },
} satisfies ExportedHandler<Env>;
