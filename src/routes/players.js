import { getDb } from '../db.js';

const SORT_FILTERS = {
  overall: '',
  '1v1': "AND g.type = '1v1'",
  '2v2': "AND g.type = '2v2'",
  ffa: "AND g.type IN ('ffa3','ffa4')",
};

export async function playersRoutes(app) {
  app.get('/', async (req) => {
    const sort = SORT_FILTERS[req.query.sort] !== undefined ? req.query.sort : 'overall';
    const filter = SORT_FILTERS[sort];
    const db = getDb();

    const rows = db.prepare(`
      SELECT
        u.tg_id,
        u.display_name,
        u.username,
        u.signature_hero_id,
        u.signature_custom,
        u.avatar_file_id,
        h.name AS hero_name,
        h.slug AS hero_slug,
        COALESCE(SUM(CASE WHEN gp.game_id IS NOT NULL ${filter} THEN gp.points_awarded ELSE 0 END), 0) AS points,
        COUNT(CASE WHEN gp.game_id IS NOT NULL ${filter} THEN 1 ELSE NULL END) AS games_played
      FROM users u
      LEFT JOIN heroes h ON h.id = u.signature_hero_id
      LEFT JOIN game_players gp ON gp.tg_id = u.tg_id
      LEFT JOIN games g ON g.id = gp.game_id AND g.status = 'finished'
      GROUP BY u.tg_id
      ORDER BY points DESC, games_played DESC, u.display_name ASC
    `).all();

    return { sort, players: rows };
  });

  app.get('/:tg_id', async (req, reply) => {
    const tgId = Number(req.params.tg_id);
    const db = getDb();
    const user = db.prepare(`
      SELECT u.*, h.name AS hero_name, h.slug AS hero_slug
      FROM users u LEFT JOIN heroes h ON h.id = u.signature_hero_id
      WHERE u.tg_id = ?
    `).get(tgId);
    if (!user) return reply.code(404).send({ error: 'not_found' });

    const totals = db.prepare(`
      SELECT
        SUM(CASE WHEN g.type = '1v1' THEN gp.points_awarded ELSE 0 END) AS pts_1v1,
        SUM(CASE WHEN g.type = '2v2' THEN gp.points_awarded ELSE 0 END) AS pts_2v2,
        SUM(CASE WHEN g.type IN ('ffa3','ffa4') THEN gp.points_awarded ELSE 0 END) AS pts_ffa,
        SUM(gp.points_awarded) AS pts_overall,
        COUNT(*) AS games_played,
        SUM(gp.is_winner) AS wins
      FROM game_players gp
      JOIN games g ON g.id = gp.game_id
      WHERE gp.tg_id = ? AND g.status = 'finished'
    `).get(tgId);

    const heroStats = db.prepare(`
      SELECT
        COALESCE(h.name, gp.hero_custom) AS hero_name,
        h.slug AS hero_slug,
        COUNT(*) AS games,
        SUM(gp.is_winner) AS wins,
        SUM(gp.points_awarded) AS points
      FROM game_players gp
      JOIN games g ON g.id = gp.game_id
      LEFT JOIN heroes h ON h.id = gp.hero_id
      WHERE gp.tg_id = ? AND g.status = 'finished'
        AND (gp.hero_id IS NOT NULL OR gp.hero_custom IS NOT NULL)
      GROUP BY hero_name
      ORDER BY games DESC, wins DESC
    `).all(tgId);

    const recent = db.prepare(`
      SELECT g.id, g.type, g.finished_at, g.notes, gp.points_awarded, gp.is_winner,
             COALESCE(h.name, gp.hero_custom) AS hero_name
      FROM game_players gp
      JOIN games g ON g.id = gp.game_id
      LEFT JOIN heroes h ON h.id = gp.hero_id
      WHERE gp.tg_id = ? AND g.status = 'finished'
      ORDER BY g.finished_at DESC
      LIMIT 20
    `).all(tgId);

    return { user, totals, heroStats, recent };
  });
}
