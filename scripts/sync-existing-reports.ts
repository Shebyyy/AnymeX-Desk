/**
 * Backfill Script: Sync existing reports to Discord Forum Channels
 *
 * Usage:
 *   bun run scripts/sync-existing-reports.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Parse .dev.vars if present
const devVarsPath = resolve(process.cwd(), '.dev.vars');
const devVars: Record<string, string> = {};
if (existsSync(devVarsPath)) {
  const content = readFileSync(devVarsPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed.slice(eqIdx + 1).trim();
      devVars[k] = v;
    }
  }
}

const botToken = process.env.DISCORD_BOT_TOKEN || devVars.DISCORD_BOT_TOKEN;
const bugsChannelId = process.env.DISCORD_FORUM_BUGS_ID || devVars.DISCORD_FORUM_BUGS_ID || '1545003724961751096';
const suggestionsChannelId = process.env.DISCORD_FORUM_SUGGESTIONS_ID || devVars.DISCORD_FORUM_SUGGESTIONS_ID || '1545003626823417906';
const extensionsChannelId = process.env.DISCORD_FORUM_EXTENSIONS_ID || devVars.DISCORD_FORUM_EXTENSIONS_ID || '1545003859380805702';
const origin = process.env.SITE_ORIGIN || 'https://desk.anymex.app';

if (!botToken) {
  console.error('❌ Error: No DISCORD_BOT_TOKEN found in .dev.vars or environment!');
  process.exit(1);
}

console.log('🔄 To sync existing reports from local or production D1, you can:');
console.log('1. Go to your tracker `/admin` panel');
console.log('2. Under "Contributor Discord Server & Forums", click:');
console.log('   "📦 Sync All Existing Reports to Discord Forums"');
console.log('\nThis will automatically iterate through all unsynced reports, create their Discord threads with tags, and link them back to the site!');
