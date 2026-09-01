# AnymeX Bug & Suggestion Tracker

## Overview

Community bug report and feature suggestion tracker for the [AnymeX](https://github.com/RyanYuuki/AnymeX) app.
Users sign in with Discord to file bugs, suggest features, vote on reports, and comment.

## Architecture

- **Framework:** Astro 7 (server output)
- **Islands:** Svelte 5
- **Hosting:** Cloudflare Workers
- **Database:** Cloudflare D1 (SQLite)
- **ORM:** Drizzle ORM (sqlite dialect, d1-http driver)
- **Sessions:** Cloudflare KV
- **Auth:** Discord OAuth 2 (`identify` scope)

## Key Concepts

### Report Kinds
- **bug** — Something broken in the AnymeX app
- **suggestion** — A feature request or improvement

### Categories
Bugs: video_player, ui_ux, login_auth, manga_reader, extension_bridge, crash, performance, novel_reader, library, tracking, other

Suggestions: player, ui_ux, library, tracking, extensions, manga_reader, novel_reader, download, other

### Platforms
android, ios, windows, macos, linux, all

### Status Flow
open → confirmed → in_progress → fixed / wont_fix / duplicate

### Deduplication
One open report per (kind, category, platform, normalized_title). Filing a duplicate auto-joins (upvotes) the existing report.

### Voting
One vote per user per report. Vote count is a denormalized counter updated atomically with the vote row.

### Attachments
Images (JPG/PNG/WebP/GIF, max 5MB, max 5 per report) and videos (MP4/WebM, max 50MB, max 1 per report).

### Comments
Anyone can comment on any report. Comments trigger notifications to the reporter.

### Discord DMs
Reporters receive DMs when their report's status changes (if a bot token is configured).

## Pages

| Route | Description |
|---|---|
| `/` | Bug & Suggestion boards with filters |
| `/new` | File a bug report or suggestion |
| `/report/[id]` | Report detail with attachments, comments, moderator controls |
| `/me` | User's reports, voted reports, notifications |
| `/admin` | Staff dashboard (mod+ only) |
| `/auth/discord` | OAuth redirect |
| `/auth/callback` | Token exchange, session creation |
| `/auth/logout` | Session destruction |
| `/vote` | Toggle vote (POST) |
| `/upload` | File upload (POST) |
| `/comments` | Comment CRUD (GET/POST/DELETE) |

## Environment Variables

```env
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_GUILD_ID=           # Optional — for staff role detection
OWNER_DISCORD_ID=             # Owner Discord ID (not in DB)
```

## Development

```bash
bun install
bun run dev        # Starts Astro dev server with Miniflare
```

## Schema

See `src/lib/db/schema.ts` for the Drizzle schema definition.
See `drizzle/0000_initial.sql` for the migration.
