/**
 * AnymeX Desk — Realtime Discord to Tracker Gateway Listener
 *
 * This script connects to the Discord Gateway WebSocket and listens for:
 * 1. New messages in Contributor forum threads -> syncs to site comments!
 * 2. Message edits in forum threads -> syncs edits to site comments!
 * 3. Message deletions in forum threads -> deletes site comments!
 * 4. Thread updates (e.g. tag changes) -> syncs status to site reports!
 *
 * Usage:
 *   bun run scripts/discord-gateway-listener.ts
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
      devVars[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
  }
}

const botToken = process.env.DISCORD_BOT_TOKEN || devVars.DISCORD_BOT_TOKEN;
const syncSecret = process.env.DISCORD_SYNC_SECRET || devVars.DISCORD_SYNC_SECRET || 'anymex_sync_8f4a9b2c6e1d3075e82f419c8a74e5bd';
const siteUrl = process.env.SITE_URL || devVars.SITE_URL || 'https://anymex-desk.asheby.workers.dev';

if (!botToken) {
  console.error('❌ Error: DISCORD_BOT_TOKEN not found in .dev.vars or environment!');
  process.exit(1);
}

console.log('🚀 Starting AnymeX Discord Gateway Sync Listener...');
console.log(`📡 Forwarding events to: ${siteUrl}/api/discord/sync`);

let ws: WebSocket | null = null;
let heartbeatInterval: any = null;
let sequence: number | null = null;

async function sendToSite(payload: Record<string, any>) {
  try {
    const res = await fetch(`${siteUrl}/api/discord/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${syncSecret}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn(`[Gateway] Site rejected event (${res.status}):`, await res.text());
    } else {
      console.log(`[Gateway] ✅ Synced event ${payload.event} to site!`);
    }
  } catch (err) {
    console.error('[Gateway] Failed to contact site:', err);
  }
}

function connect() {
  console.log('[Gateway] Connecting to Discord Gateway...');
  ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');

  ws.onopen = () => {
    console.log('[Gateway] Connected to Discord WebSocket.');
  };

  ws.onmessage = async (event) => {
    const data = JSON.parse(event.data.toString());
    const { op, d, s, t } = data;
    if (s) sequence = s;

    // Opcode 10: Hello (start heartbeat & identify)
    if (op === 10) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = setInterval(() => {
        ws?.send(JSON.stringify({ op: 1, d: sequence }));
      }, d.heartbeat_interval);

      // Send Identify (Guilds + Guild Messages + Message Content)
      // Intents: GUILDS (1) + GUILD_MESSAGES (512) + MESSAGE_CONTENT (32768) = 33281
      ws?.send(JSON.stringify({
        op: 2,
        d: {
          token: botToken,
          intents: 33281,
          properties: {
            os: 'linux',
            browser: 'anymex-bridge',
            device: 'anymex-bridge',
          },
        },
      }));
      return;
    }

    // Opcode 0: Dispatch events
    if (op === 0) {
      // 1. New Message Created
      if (t === 'MESSAGE_CREATE') {
        // Ignore bot messages (avoids echo loops)
        if (d.author?.bot) return;

        // Only process messages that are in a thread
        if (d.thread || d.channel_id) {
          await sendToSite({
            event: 'MESSAGE_CREATE',
            threadId: d.channel_id,
            messageId: d.id,
            content: d.content,
            author: {
              id: d.author.id,
              username: d.author.global_name || d.author.username,
              avatar: d.author.avatar,
            },
            message_reference: d.message_reference,
          });
        }
      }

      // 2. Message Updated / Edited
      if (t === 'MESSAGE_UPDATE') {
        if (d.author?.bot) return;
        if (d.content) {
          await sendToSite({
            event: 'MESSAGE_UPDATE',
            threadId: d.channel_id,
            messageId: d.id,
            content: d.content,
          });
        }
      }

      // 3. Message Deleted
      if (t === 'MESSAGE_DELETE') {
        await sendToSite({
          event: 'MESSAGE_DELETE',
          threadId: d.channel_id,
          messageId: d.id,
        });
      }

      // 4. Thread Status Changed (tags changed)
      if (t === 'THREAD_UPDATE') {
        await sendToSite({
          event: 'THREAD_UPDATE',
          threadId: d.id,
          tagNames: d.applied_tags,
        });
      }
    }
  };

  ws.onclose = (e) => {
    console.warn(`[Gateway] Disconnected (${e.code}). Reconnecting in 5s...`);
    clearInterval(heartbeatInterval);
    setTimeout(connect, 5000);
  };

  ws.onerror = (err) => {
    console.error('[Gateway] WebSocket error:', err);
  };
}

connect();
