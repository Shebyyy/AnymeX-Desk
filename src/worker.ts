/**
 * Cloudflare Workers entry point.
 *
 * Astro's cloudflare adapter supports a custom worker entrypoint via the
 * `workerEntrypoint` option. This file re-exports Astro's default fetch
 * handler and adds a `scheduled` export so Cloudflare Workers routes cron
 * trigger events to our Discord → Site polling handler.
 *
 * Reference: https://docs.astro.build/en/guides/integrations-guide/cloudflare/#cloudflare-workers-entrypoint
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { onScheduled } from './pages/api/discord/poll';

// The Astro cloudflare adapter generates _worker.js and expects this module
// to extend WorkerEntrypoint so it can merge fetch + scheduled.
export default class extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    // Delegate all HTTP requests to Astro's generated handler
    return (this.env as any).__ASTRO_FETCH(request, this.env, this.ctx);
  }

  async scheduled(event: ScheduledEvent): Promise<void> {
    this.ctx.waitUntil(onScheduled(event, this.env));
  }
}
