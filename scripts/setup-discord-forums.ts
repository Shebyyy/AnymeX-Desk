/**
 * Setup Discord Forum Channels & Tags for AnymeX Desk Contributor Server
 *
 * Usage:
 *   bun run scripts/setup-discord-forums.ts
 * or
 *   DISCORD_BOT_TOKEN="your-token" bun run scripts/setup-discord-forums.ts
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
const guildId = process.env.CONTRIBUTOR_GUILD_ID || devVars.CONTRIBUTOR_GUILD_ID || '1545003117018357850';
const bugsChannelId = process.env.DISCORD_FORUM_BUGS_ID || devVars.DISCORD_FORUM_BUGS_ID || '1545003724961751096';
const suggestionsChannelId = process.env.DISCORD_FORUM_SUGGESTIONS_ID || devVars.DISCORD_FORUM_SUGGESTIONS_ID || '1545003626823417906';
const extensionsChannelId = process.env.DISCORD_FORUM_EXTENSIONS_ID || devVars.DISCORD_FORUM_EXTENSIONS_ID || '1545003859380805702';

const DISCORD_API = 'https://discord.com/api/v10';

interface DiscordTag {
  id?: string;
  name: string;
  moderated?: boolean;
  emoji_id?: string | null;
  emoji_name?: string | null;
}

const STATUS_TAGS: DiscordTag[] = [
  { name: 'Open', moderated: false, emoji_name: '🟢' },
  { name: 'In Progress', moderated: true, emoji_name: '🟡' },
  { name: 'Fixed', moderated: true, emoji_name: '✅' },
  { name: 'Duplicate', moderated: true, emoji_name: '🔄' },
  { name: "Won't Fix", moderated: true, emoji_name: '❌' },
];

const SUGGESTION_STATUS_TAGS: DiscordTag[] = [
  { name: 'Under Review', moderated: false, emoji_name: '🔍' },
  { name: 'Planned', moderated: true, emoji_name: '💡' },
  { name: 'In Progress', moderated: true, emoji_name: '🟡' },
  { name: 'Completed', moderated: true, emoji_name: '✅' },
  { name: 'Declined', moderated: true, emoji_name: '❌' },
  { name: 'Duplicate', moderated: true, emoji_name: '🔄' },
];

const PLATFORM_TAGS: DiscordTag[] = [
  { name: 'Android', moderated: false },
  { name: 'iOS', moderated: false },
  { name: 'Windows', moderated: false },
  { name: 'macOS', moderated: false },
  { name: 'Linux', moderated: false },
  { name: 'All Platforms', moderated: false },
];

const SUGGESTION_CATEGORY_TAGS: DiscordTag[] = [
  { name: 'Player', moderated: false },
  { name: 'UI / UX', moderated: false },
  { name: 'Library', moderated: false },
  { name: 'Tracking', moderated: false },
  { name: 'Extensions', moderated: false },
  { name: 'Manga Reader', moderated: false },
  { name: 'Novel Reader', moderated: false },
  { name: 'Download', moderated: false },
  { name: 'Other', moderated: false },
];

const EXTENSION_TAGS: DiscordTag[] = [
  { name: 'Mihon / Aniyomi', moderated: false },
  { name: 'Mangayomi', moderated: false },
  { name: 'Sora', moderated: false },
  { name: 'LNReader', moderated: false },
  { name: 'Cloudstream', moderated: false },
  { name: 'Kotatsu', moderated: false },
  { name: 'Other Source', moderated: false },
];

async function setupChannel(channelId: string, channelName: string, desiredTags: DiscordTag[]) {
  console.log(`\n========================================`);
  console.log(`Processing #${channelName} (${channelId})...`);

  const getRes = await fetch(`${DISCORD_API}/channels/${channelId}`, {
    headers: { Authorization: `Bot ${botToken}` },
  });

  if (!getRes.ok) {
    console.error(`❌ Failed to get channel ${channelId}:`, getRes.status, await getRes.text());
    return;
  }

  const channel = (await getRes.json()) as { name: string; available_tags?: DiscordTag[] };
  console.log(`Connected to channel: "${channel.name}"`);

  const existingTags = channel.available_tags || [];
  const existingNames = new Set(existingTags.map((t) => t.name.toLowerCase()));

  const merged = [...existingTags];
  let addedCount = 0;

  for (const tag of desiredTags) {
    if (!existingNames.has(tag.name.toLowerCase())) {
      if (merged.length < 20) {
        merged.push(tag);
        addedCount++;
      } else {
        console.warn(`⚠️ Maximum 20 tags reached. Skipped tag: "${tag.name}"`);
      }
    }
  }

  if (addedCount > 0) {
    console.log(`Adding ${addedCount} new tags...`);
    const patchRes = await fetch(`${DISCORD_API}/channels/${channelId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ available_tags: merged }),
    });

    if (!patchRes.ok) {
      console.error(`❌ Failed to update tags:`, patchRes.status, await patchRes.text());
      return;
    }

    const updated = (await patchRes.json()) as { available_tags: DiscordTag[] };
    console.log(`✅ Successfully updated tags! Current tags in channel:`);
    for (const t of updated.available_tags) {
      console.log(`   - ${t.emoji_name ?? '🏷️'} ${t.name} (ID: ${t.id})`);
    }
  } else {
    console.log(`✅ All desired tags already exist! Current tags in channel:`);
    for (const t of existingTags) {
      console.log(`   - ${t.emoji_name ?? '🏷️'} ${t.name} (ID: ${t.id})`);
    }
  }

  // Verify and ensure Forum Webhook exists (needed for user profile & avatar sync)
  try {
    const hookRes = await fetch(`${DISCORD_API}/channels/${channelId}/webhooks`, {
      headers: { Authorization: `Bot ${botToken}` },
    });
    if (hookRes.ok) {
      const hooks = (await hookRes.json()) as Array<{ id: string; token?: string; name: string }>;
      const existing = hooks.find((h) => h.token);
      if (existing) {
        console.log(`✅ Webhook ready on #${channelName} (ID: ${existing.id})`);
      } else {
        const createHook = await fetch(`${DISCORD_API}/channels/${channelId}/webhooks`, {
          method: 'POST',
          headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'AnymeX Desk Bridge' }),
        });
        if (createHook.ok) {
          console.log(`✅ Created new Webhook for #${channelName}!`);
        } else {
          console.warn(`⚠️ Could not create webhook for #${channelName} (${createHook.status}). Please check bot permissions.`);
        }
      }
    } else {
      console.warn(`⚠️ Cannot list webhooks for #${channelName} (${hookRes.status}). Check if Bot has 'Manage Webhooks' permission in Discord!`);
    }
  } catch (err) {
    console.warn(`⚠️ Error checking webhook on #${channelName}:`, err);
  }
}

async function main() {
  console.log(`Discord Contributor Forum Tag Setup`);
  console.log(`Server ID: ${guildId}`);

  if (!botToken) {
    console.error(`\n❌ Error: No Discord bot token found!`);
    console.error(`Please set DISCORD_BOT_TOKEN in .dev.vars or run:`);
    console.error(`DISCORD_BOT_TOKEN="your_token" bun run scripts/setup-discord-forums.ts\n`);
    process.exit(1);
  }

  await setupChannel(bugsChannelId, 'bugs', [...STATUS_TAGS, ...PLATFORM_TAGS]);
  await setupChannel(suggestionsChannelId, 'suggestions', [...SUGGESTION_STATUS_TAGS, ...SUGGESTION_CATEGORY_TAGS]);
  await setupChannel(extensionsChannelId, 'extension-issues', [...STATUS_TAGS, ...EXTENSION_TAGS]);

  console.log(`\n🎉 Done! All 3 forum channels are configured with tags.`);
}

main().catch(console.error);
