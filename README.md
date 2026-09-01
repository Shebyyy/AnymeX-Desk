# AnymeX Desk

Bug report and feature suggestion tracker for [AnymeX](https://github.com/RyanYuuki/AnymeX) and [AnymeX Extension Runtime Bridge](https://github.com/RyanYuuki/AnymeXExtensionRuntimeBridge).

Users sign in with Discord to file bugs, suggest features, and vote on what matters most. One report per issue — filing a duplicate adds you to the existing one instead.

## Features

- **Bug reports** with categories (Video Player, UI/UX, Crash, etc.) and platform selection
- **Feature suggestions** with categories (Player, Library, Tracking, etc.)
- **Voting** — one vote per user per report; vote count = priority
- **Deduplication** — same issue auto-joins instead of creating duplicates
- **File attachments** — images (up to 5, 5 MB each) and video (1, 50 MB)
- **Comments** — discussion on any report
- **Discord DMs** — reporters notified on status changes
- **Admin dashboard** — staff can manage reports, users, and settings
- **Audit log** — all staff actions recorded

## Stack

Astro 7 (`output: 'server'`) on Cloudflare Workers, Svelte 5 islands, D1 + Drizzle ORM, Astro sessions on Workers KV, Discord OAuth.

## Setup

Bun only.

```sh
bun install
cp .dev.vars.example .dev.vars     # add Discord client ID/secret and owner ID
bunx wrangler d1 create anymex-desk   # paste database_id into wrangler.jsonc
bun run db:local                   # apply migrations to local D1
bun run db:seed                    # load default settings
bun run dev
```

### Environment Variables

| Variable | Where | Description |
|---|---|---|
| `DISCORD_CLIENT_ID` | `wrangler.jsonc` vars | Discord OAuth application ID |
| `DISCORD_CLIENT_SECRET` | Wrangler secret | Discord OAuth client secret |
| `OWNER_DISCORD_ID` | Wrangler secret | Discord ID of the site owner |
| `DISCORD_GUILD_ID` | `wrangler.jsonc` vars | Optional — for staff role detection |

### Discord Setup

1. Create a Discord application at [discord.com/developers/applications](https://discord.com/developers/applications)
2. Under OAuth2, add `https://<your-worker>.workers.dev/auth/callback` to Redirects
3. Copy the Client ID into `wrangler.jsonc`
4. Set the Client Secret as a Wrangler secret: `bunx wrangler secret put DISCORD_CLIENT_SECRET`

## Deploying

```sh
bunx wrangler secret put DISCORD_CLIENT_SECRET
bunx wrangler secret put OWNER_DISCORD_ID
bun run deploy      # build and deploy; D1 and KV are provisioned automatically
bun run db:remote   # apply migrations to remote D1
```

### Migrations

```sh
bun run db:remote      # after any schema change
```

## Scripts

| Command | What |
|---|---|
| `bun run dev` | Local dev on workerd with persisted D1/KV |
| `bun run db:generate` | Generate a migration from the Drizzle schema |
| `bun run db:local` / `db:remote` | Apply migrations |
| `bun run db:seed` | Load default settings into local D1 |
| `bun run types` | Regenerate `worker-configuration.d.ts` |
| `bun run check` | Typecheck |
| `bun run deploy` | Build and deploy |

## Pages

| Route | Description |
|---|---|
| `/` | Bug & Suggestion boards |
| `/new` | File a report |
| `/report/[id]` | Report detail |
| `/me` | Your reports, votes, notifications |
| `/admin` | Staff dashboard |

## License

MIT
