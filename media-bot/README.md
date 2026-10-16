# Omni (OmniBot)

The all-in-one Telegram companion for **Anime, Manga, and Light Novels** with instant media search, reverse image (sauce) scene identification, airing countdown schedules, and release alerts.

## 🚀 Key Features

1. **🔍 Media Search & Deep Links:**
   * `/anime <title>` — Search Anime with cover art, scores, airing countdowns, and synopsis.
   * `/manga <title>` — Search Manga with chapter/volume details.
   * `/novel <title>` — Search Light Novels.
   * Inline Query: Type `@YourBotName <query>` in **any chat** to search and share rich media cards.
   * **▶️ Open in AnymeX:** Instant deep-link (`anymex://anilist/...`) opening directly in the app.

2. **📸 Sauce / Reverse Image Finder:**
   * Powered by `trace.moe`.
   * Forward or send any screenshot to identify:
     * Anime title
     * Exact episode number
     * Exact scene timestamp (e.g. `14:22`)
     * Match accuracy percentage
     * 5-second video preview clip of the matched scene

3. **🔔 Airing & Release Alerts:**
   * `/airing` — Live schedule of episodes airing today and tomorrow.
   * `/track` & `/untrack` — Subscribe to notifications for any anime or manga.
   * `/sync <username>` — One-click sync of your active AniList Watching/Reading list.
   * `/mytracks` — Manage your active subscriptions.

---

## 🛠 Deployment & Setup (Telegram Cloud)

This bot is powered by **TGCloud** serverless (SQLite + Telegram Webhook runtime).

### 1. Create Bot on Telegram
1. Message **[@BotFather](https://t.me/BotFather)** on Telegram.
2. Run `/newbot` and choose a name and username (e.g. `AnymeXMediaBot`).
3. Turn on Inline Mode via `/setinline`.
4. Copy the Bot API Token.

### 2. Connect & Deploy
In the `media-bot` directory:
```bash
# Set your TGCloud token (or run tgcloud login)
$env:TGCLOUD_TOKEN="<your_tgcloud_app_token>"

# Push schema and handlers
bun run deploy:force

# Run SQLite migrations
bun run migrate
```
