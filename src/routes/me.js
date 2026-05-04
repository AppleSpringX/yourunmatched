import { requireAuth } from '../auth.js';
import { getDb, getTopThreeRanks } from '../db.js';

export async function meRoutes(app) {
  app.get('/', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    return { user: enrich(user) };
  });

  // Per-hero winrate for the current user — used by hero-picker UI to inform picks.
  app.get('/hero-stats', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const db = getDb();
    const rows = db.prepare(`
      SELECT gp.hero_id, COUNT(*) AS games, SUM(gp.is_winner) AS wins
      FROM game_players gp
      JOIN games g ON g.id = gp.game_id
      WHERE gp.tg_id = ? AND g.status = 'finished' AND gp.hero_id IS NOT NULL
      GROUP BY gp.hero_id
    `).all(user.tg_id);
    const stats = {};
    for (const r of rows) stats[r.hero_id] = { games: r.games, wins: r.wins };
    return { stats };
  });

  app.put('/', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;

    const { display_name, signature_hero_id, signature_custom, privacy } = req.body || {};
    const db = getDb();

    if (typeof display_name === 'string' && display_name.trim().length > 0) {
      db.prepare('UPDATE users SET display_name = ? WHERE tg_id = ?').run(
        display_name.trim().slice(0, 64),
        user.tg_id
      );
    }
    if (signature_hero_id !== undefined) {
      const heroId = signature_hero_id ? Number(signature_hero_id) : null;
      db.prepare(
        'UPDATE users SET signature_hero_id = ?, signature_custom = NULL WHERE tg_id = ?'
      ).run(heroId, user.tg_id);
    } else if (typeof signature_custom === 'string') {
      db.prepare(
        'UPDATE users SET signature_hero_id = NULL, signature_custom = ? WHERE tg_id = ?'
      ).run(signature_custom.trim().slice(0, 64) || null, user.tg_id);
    }
    if (privacy && typeof privacy === 'object') {
      const fields = ['show_breakdown', 'show_heroes', 'show_recent'];
      for (const k of fields) {
        if (typeof privacy[k] === 'boolean') {
          db.prepare(`UPDATE users SET ${k} = ? WHERE tg_id = ?`).run(privacy[k] ? 1 : 0, user.tg_id);
        }
      }
    }

    const updated = db.prepare('SELECT * FROM users WHERE tg_id = ?').get(user.tg_id);
    return { user: enrich(updated) };
  });
}

function enrich(user) {
  const rank = getTopThreeRanks().get(user.tg_id) ?? null;
  const privacy = {
    show_breakdown: !!user.show_breakdown,
    show_heroes: !!user.show_heroes,
    show_recent: !!user.show_recent,
  };
  if (!user.signature_hero_id) return { ...user, rank, privacy };
  const db = getDb();
  const hero = db.prepare('SELECT id, name, slug, set_name FROM heroes WHERE id = ?').get(user.signature_hero_id);
  return { ...user, hero, rank, privacy };
}
