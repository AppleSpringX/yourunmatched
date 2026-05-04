# Unmatched Club

Telegram Mini App for an Unmatched (Restoration Games) board-game community: player profiles, room-based games, simple round-robin tournaments, manual scoring with auto-computed ratings.

## Stack

- **Backend:** Node.js 20+ (Fastify) on top of the built-in `node:sqlite` module — no native dependencies, no compile step.
- **Frontend:** vanilla HTML/CSS/JS + Telegram WebApp SDK, no bundler.
- **Bot:** [grammY](https://grammy.dev). Polling for dev, webhook for prod.
- **Hosting target:** wispbyte free tier (Node.js egg, 0.5 GiB RAM, 1 GiB disk).

## Local development

```bash
npm install
cp .env.example .env
# fill BOT_TOKEN (from @BotFather) and WEBAPP_URL (HTTPS, public)
npm run dev
```

Telegram requires an HTTPS URL for `WEBAPP_URL`. For local testing use a tunnel (ngrok / cloudflared).

## Environment variables

| Name             | Required | Notes                                                             |
|------------------|----------|-------------------------------------------------------------------|
| `BOT_TOKEN`      | yes      | from @BotFather                                                   |
| `WEBAPP_URL`     | yes      | public HTTPS URL where the app is reachable                       |
| `PORT`           | no       | wispbyte injects automatically; defaults to 3000 locally          |
| `DB_PATH`        | no       | SQLite file path; defaults to `./data/unmatched.db`               |
| `SESSION_SECRET` | yes (prod) | long random string, used to sign session cookies                |
| `BOT_MODE`       | no       | `polling` (default) or `webhook`                                  |
| `WEBHOOK_URL`    | only webhook | public base URL for `/bot/webhook`                            |

## Scoring rules

| Mode | Points |
|---|---|
| 1v1 | winner 3 / loser 0 |
| 2v2 | winner-alive 3 · winner-eliminated 2 · loser-last-eliminated 1 · loser-first-eliminated 0 |
| FFA-3 | 1st 3 / 2nd 2 / 3rd 0 |
| FFA-4 | 1st 3 / 2nd 2 / 3rd 1 / 4th 0 |

Implemented as a pure function in [`src/scoring.js`](src/scoring.js).

## Project layout

```
src/
  server.js      Fastify app entry
  config.js      env loader
  db.js          SQLite migrations + hero seed
  auth.js        Telegram initData HMAC + session
  bot.js         grammY bot (start, photo handler, webhook/polling)
  scoring.js     point computation per game type
  data/heroes.json   ~60 canonical heroes by set
  routes/        HTTP API
public/          Telegram Mini App (index.html, app.css, app.js, heroes/)
```
