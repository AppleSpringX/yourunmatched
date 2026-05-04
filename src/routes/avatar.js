import { getDb } from '../db.js';
import { getAvatarUrl } from '../bot.js';

const cache = new Map(); // file_id -> { url, expiresAt }
const TTL_MS = 1000 * 60 * 30;

export async function avatarRoutes(app) {
  // Proxy a player's bot-uploaded avatar via Telegram's file API.
  // We keep the bot token server-side; the client just hits /api/avatar/:tg_id.
  app.get('/:tg_id', async (req, reply) => {
    const tgId = Number(req.params.tg_id);
    const db = getDb();
    const row = db.prepare('SELECT avatar_file_id FROM users WHERE tg_id = ?').get(tgId);
    if (!row || !row.avatar_file_id) return reply.code(404).send({ error: 'no_avatar' });

    const cached = cache.get(row.avatar_file_id);
    let url = cached && cached.expiresAt > Date.now() ? cached.url : null;
    if (!url) {
      url = await getAvatarUrl(row.avatar_file_id);
      if (!url) return reply.code(502).send({ error: 'fetch_failed' });
      cache.set(row.avatar_file_id, { url, expiresAt: Date.now() + TTL_MS });
    }

    const upstream = await fetch(url);
    if (!upstream.ok) return reply.code(502).send({ error: 'fetch_failed' });
    reply.header('content-type', upstream.headers.get('content-type') || 'image/jpeg');
    reply.header('cache-control', 'public, max-age=600');
    return reply.send(Buffer.from(await upstream.arrayBuffer()));
  });
}
