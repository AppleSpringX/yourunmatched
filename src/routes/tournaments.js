import { getDb, getTopThreeRanks, transaction } from '../db.js';
import { requireAuth } from '../auth.js';
import { PLAYER_COUNT } from '../scoring.js';

// MVP: only 1v1 round-robin tournaments. 2v2/FFA bracket modes come later.
const SUPPORTED_FORMATS = new Set(['round_robin']);
const SUPPORTED_GAME_TYPES = new Set(['1v1']);

export async function tournamentsRoutes(app) {
  // List tournaments (active first, then finished)
  app.get('/', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const db = getDb();
    const rows = db.prepare(`
      SELECT t.*,
             u.display_name AS creator_name,
             (SELECT COUNT(*) FROM tournament_players WHERE tournament_id = t.id) AS players_count,
             (SELECT COUNT(*) FROM games WHERE tournament_id = t.id) AS matches_total,
             (SELECT COUNT(*) FROM games WHERE tournament_id = t.id AND status = 'finished') AS matches_done
      FROM tournaments t
      JOIN users u ON u.tg_id = t.creator_tg_id
      ORDER BY (t.status = 'finished'), t.created_at DESC
    `).all();
    return { tournaments: rows };
  });

  // Create tournament
  // body: { name, format, game_type, players: [tg_id1, tg_id2, ...] }
  app.post('/', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const { name, format, game_type, players: playerIds } = req.body || {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      return reply.code(400).send({ error: 'invalid_name' });
    }
    if (!SUPPORTED_FORMATS.has(format)) return reply.code(400).send({ error: 'invalid_format' });
    if (!SUPPORTED_GAME_TYPES.has(game_type)) return reply.code(400).send({ error: 'invalid_game_type' });
    if (!Array.isArray(playerIds) || playerIds.length < 3) {
      return reply.code(400).send({ error: 'need_min_3_players' });
    }
    const uniqIds = [...new Set(playerIds.map(Number))].filter(Number.isFinite);
    if (uniqIds.length !== playerIds.length) {
      return reply.code(400).send({ error: 'duplicate_players' });
    }

    const db = getDb();
    // Verify all players exist
    const placeholders = uniqIds.map(() => '?').join(',');
    const existing = db.prepare(
      `SELECT tg_id FROM users WHERE tg_id IN (${placeholders})`
    ).all(...uniqIds);
    if (existing.length !== uniqIds.length) {
      return reply.code(400).send({ error: 'unknown_player' });
    }

    let tournamentId;
    transaction(db, () => {
      const r = db.prepare(`
        INSERT INTO tournaments (name, format, game_type, creator_tg_id, status, created_at)
        VALUES (?, ?, ?, ?, 'open', ?)
      `).run(name.trim().slice(0, 80), format, game_type, user.tg_id, Date.now());
      tournamentId = Number(r.lastInsertRowid);

      const insertPlayer = db.prepare(
        'INSERT INTO tournament_players (tournament_id, tg_id) VALUES (?, ?)'
      );
      for (const tg of uniqIds) insertPlayer.run(tournamentId, tg);

      // Generate round-robin matches: every distinct pair plays once.
      const insertGame = db.prepare(`
        INSERT INTO games (type, tournament_id, creator_tg_id, status, created_at)
        VALUES (?, ?, ?, 'open', ?)
      `);
      const insertGamePlayer = db.prepare(
        'INSERT INTO game_players (game_id, tg_id, team) VALUES (?, ?, NULL)'
      );
      const now = Date.now();
      for (let i = 0; i < uniqIds.length; i++) {
        for (let j = i + 1; j < uniqIds.length; j++) {
          const gr = insertGame.run(game_type, tournamentId, user.tg_id, now);
          const gameId = Number(gr.lastInsertRowid);
          insertGamePlayer.run(gameId, uniqIds[i]);
          insertGamePlayer.run(gameId, uniqIds[j]);
        }
      }
    });

    return { id: tournamentId };
  });

  // Tournament detail with players, standings, match list
  app.get('/:id', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const db = getDb();
    const id = Number(req.params.id);
    const tournament = db.prepare(`
      SELECT t.*, u.display_name AS creator_name
      FROM tournaments t JOIN users u ON u.tg_id = t.creator_tg_id
      WHERE t.id = ?
    `).get(id);
    if (!tournament) return reply.code(404).send({ error: 'not_found' });

    // Standings: sum of points across finished tournament matches
    const standings = db.prepare(`
      SELECT u.tg_id, u.display_name, u.avatar_file_id, u.signature_hero_id,
             h.slug AS hero_slug, h.name AS hero_name,
             COALESCE(SUM(gp.points_awarded), 0) AS points,
             COUNT(CASE WHEN g.status = 'finished' THEN 1 END) AS games_played,
             SUM(CASE WHEN g.status = 'finished' AND gp.is_winner = 1 THEN 1 ELSE 0 END) AS wins
      FROM tournament_players tp
      JOIN users u ON u.tg_id = tp.tg_id
      LEFT JOIN heroes h ON h.id = u.signature_hero_id
      LEFT JOIN game_players gp ON gp.tg_id = tp.tg_id
      LEFT JOIN games g ON g.id = gp.game_id AND g.tournament_id = tp.tournament_id
      WHERE tp.tournament_id = ?
      GROUP BY u.tg_id
      ORDER BY points DESC, wins DESC, u.display_name ASC
    `).all(id);

    const ranks = getTopThreeRanks();
    for (const s of standings) s.rank = ranks.get(s.tg_id) ?? null;

    // Match list — open matches first, then finished
    const matches = db.prepare(`
      SELECT g.id, g.type, g.status, g.finished_at,
             gp1.tg_id AS p1_tg_id, u1.display_name AS p1_name, gp1.is_winner AS p1_won,
             gp2.tg_id AS p2_tg_id, u2.display_name AS p2_name, gp2.is_winner AS p2_won
      FROM games g
      JOIN game_players gp1 ON gp1.game_id = g.id
      JOIN users u1 ON u1.tg_id = gp1.tg_id
      JOIN game_players gp2 ON gp2.game_id = g.id AND gp2.tg_id != gp1.tg_id
      JOIN users u2 ON u2.tg_id = gp2.tg_id
      WHERE g.tournament_id = ? AND gp1.rowid < gp2.rowid
      ORDER BY (g.status = 'finished'), g.id ASC
    `).all(id);

    return { tournament, standings, matches };
  });

  // Mark tournament as finished (creator only) — UI button to "close" it
  app.post('/:id/finish', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const db = getDb();
    const id = Number(req.params.id);
    const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(id);
    if (!t) return reply.code(404).send({ error: 'not_found' });
    if (t.creator_tg_id !== user.tg_id) return reply.code(403).send({ error: 'not_creator' });
    db.prepare("UPDATE tournaments SET status = 'finished' WHERE id = ?").run(id);
    return { ok: true };
  });

  // Delete tournament (creator only). Detaches finished games (sets tournament_id=NULL
  // so their results stick around as standalone matches), deletes still-open matches.
  app.post('/:id/delete', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const db = getDb();
    const id = Number(req.params.id);
    const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(id);
    if (!t) return reply.code(404).send({ error: 'not_found' });
    if (t.creator_tg_id !== user.tg_id) return reply.code(403).send({ error: 'not_creator' });

    transaction(db, () => {
      // Open matches that were never played: just delete them outright.
      db.prepare("DELETE FROM games WHERE tournament_id = ? AND status = 'open'").run(id);
      // Finished matches: keep history, just unlink from the tournament.
      db.prepare(
        "UPDATE games SET tournament_id = NULL WHERE tournament_id = ? AND status = 'finished'"
      ).run(id);
      db.prepare('DELETE FROM tournament_players WHERE tournament_id = ?').run(id);
      db.prepare('DELETE FROM tournaments WHERE id = ?').run(id);
    });
    return { ok: true };
  });
}
