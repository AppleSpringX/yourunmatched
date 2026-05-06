# Unmatched Club

Telegram Mini App for an Unmatched (Restoration Games) board-game community: profiles, ratings, rooms with manual / random / draft hero selection, and round-robin tournaments.

## Stack

- **Backend:** Node.js + Fastify + built-in `node:sqlite` (no native deps)
- **Bot:** grammY, polling mode
- **Frontend:** vanilla HTML/CSS/JS + Telegram WebApp SDK (no build step)
- **Auth:** Telegram `initData` HMAC validation, signed cookie session
- **Hosting:**
  - Backend on [wispbyte](https://wispbyte.com) free tier (HTTP only, port 9255), auto-deploy via `git pull` on restart (`AUTO_UPDATE=1`)
  - HTTPS proxy on [Render](https://render.com) free tier (`*.onrender.com` is not on AdGuard/anti-phishing block-lists, unlike `*.workers.dev`)
  - DNS resolution via DuckDNS (`yourunmatched.duckdns.org` → wispbyte server IP)

## Repo layout

```
src/
├── server.js          # Fastify app + bot startup + keepalive ping to Render
├── db.js              # SQLite schema, seed, idempotent migrations
├── config.js          # env loader (dotenv-lite)
├── auth.js            # initData HMAC + cookie session
├── bot.js             # /start handler + photo→avatar handler (grammY)
├── notify.js          # Telegram DM helpers (draft turn, results, joins)
├── scoring.js         # pure scoring engine for 1v1 / 2v2 / FFA-3 / FFA-4
├── data/heroes.json   # seed: 60 heroes across 12 sets (russified)
└── routes/            # Fastify route modules
    ├── auth.js me.js heroes.js players.js avatar.js
    ├── rooms.js       # rooms, draft, randomize, finalize, reset
    ├── tournaments.js # round-robin 1v1, standings, delete
    └── admin.js       # ADMIN_TOKEN-gated wipe-stats / wipe-all

public/
├── index.html app.css app.js favicon.svg
└── heroes/<slug>.webp # optional portraits (letter fallback if absent)

proxy/
└── server.js          # 20-line transparent HTTPS-fronted Node proxy on Render
```

## Local dev

```
npm install
cp .env.example .env   # set BOT_TOKEN, WEBAPP_URL, etc.
npm run dev            # auto-restart on save
```

## Deployment

Push to `main` → wispbyte auto-pulls on next restart. Render also redeploys on git push (proxy/ subdir).

Env vars on wispbyte (`/home/container/.env`):
- `BOT_TOKEN`, `WEBAPP_URL` (= public Render URL), `BOT_MODE=polling`
- `DB_PATH=./data/unmatched.db`, `SESSION_SECRET`, optional `ADMIN_TOKEN`

## Admin

To soft-reset stats while preserving user accounts:

```bash
curl -X POST -H "X-Admin-Token: $ADMIN_TOKEN" \
  https://yourunmatched.onrender.com/api/admin/wipe-stats
```

`/wipe-all` also nukes users.
