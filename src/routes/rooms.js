import { getDb, getTopThreeRanks, transaction } from '../db.js';
import { requireAuth } from '../auth.js';
import { computePoints, PLAYER_COUNT } from '../scoring.js';

export async function roomsRoutes(app) {
  // List open rooms
  app.get('/', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const db = getDb();
    const rooms = db.prepare(`
      SELECT g.id, g.type, g.creator_tg_id, g.notes, g.created_at, g.tournament_id,
             u.display_name AS creator_name,
             t.name AS tournament_name,
             (SELECT COUNT(*) FROM game_players WHERE game_id = g.id) AS players_count
      FROM games g
      JOIN users u ON u.tg_id = g.creator_tg_id
      LEFT JOIN tournaments t ON t.id = g.tournament_id
      WHERE g.status = 'open'
      ORDER BY g.created_at DESC
    `).all();
    return {
      rooms: rooms.map((r) => ({ ...r, target_count: PLAYER_COUNT[r.type] })),
    };
  });

  // Create a room (creator auto-joins as participant, team 0 for 2v2)
  app.post('/', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const { type } = req.body || {};
    if (!PLAYER_COUNT[type]) return reply.code(400).send({ error: 'invalid_type' });
    const db = getDb();
    let roomId;
    transaction(db, () => {
      const r = db.prepare(
        "INSERT INTO games (type, creator_tg_id, status, created_at) VALUES (?, ?, 'open', ?)"
      ).run(type, user.tg_id, Date.now());
      roomId = Number(r.lastInsertRowid);
      const team = type === '2v2' ? 0 : null;
      db.prepare(
        'INSERT INTO game_players (game_id, tg_id, team) VALUES (?, ?, ?)'
      ).run(roomId, user.tg_id, team);
    });
    return { id: roomId };
  });

  // Room detail with participants
  app.get('/:id', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const db = getDb();
    const room = db.prepare(`
      SELECT g.*, t.name AS tournament_name
      FROM games g
      LEFT JOIN tournaments t ON t.id = g.tournament_id
      WHERE g.id = ?
    `).get(Number(req.params.id));
    if (!room) return reply.code(404).send({ error: 'not_found' });
    const players = db.prepare(`
      SELECT gp.tg_id, gp.team, gp.hero_id, gp.hero_custom, gp.elimination_order,
             gp.is_winner, gp.points_awarded,
             u.display_name, u.avatar_file_id, u.signature_hero_id,
             h.name AS hero_name, h.slug AS hero_slug
      FROM game_players gp
      JOIN users u ON u.tg_id = gp.tg_id
      LEFT JOIN heroes h ON h.id = gp.hero_id
      WHERE gp.game_id = ?
      ORDER BY rowid ASC
    `).all(room.id);
    const ranks = getTopThreeRanks();
    for (const p of players) p.rank = ranks.get(p.tg_id) ?? null;
    return { room: { ...room, players, target_count: PLAYER_COUNT[room.type] } };
  });

  // Join room
  app.post('/:id/join', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const db = getDb();
    const id = Number(req.params.id);
    const room = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
    if (!room) return reply.code(404).send({ error: 'not_found' });
    if (room.status !== 'open') return reply.code(400).send({ error: 'not_open' });
    if (room.tournament_id) return reply.code(400).send({ error: 'tournament_match' });
    if (db.prepare('SELECT 1 FROM game_players WHERE game_id = ? AND tg_id = ?').get(id, user.tg_id)) {
      return reply.code(400).send({ error: 'already_in' });
    }
    const count = db.prepare('SELECT COUNT(*) AS n FROM game_players WHERE game_id = ?').get(id).n;
    if (count >= PLAYER_COUNT[room.type]) return reply.code(400).send({ error: 'full' });

    let team = null;
    if (room.type === '2v2') {
      const t0 = db.prepare('SELECT COUNT(*) AS n FROM game_players WHERE game_id = ? AND team = 0').get(id).n;
      team = t0 < 2 ? 0 : 1;
    }
    db.prepare('INSERT INTO game_players (game_id, tg_id, team) VALUES (?, ?, ?)').run(id, user.tg_id, team);
    return { ok: true };
  });

  // Leave room (creator leaving deletes the room)
  app.post('/:id/leave', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const db = getDb();
    const id = Number(req.params.id);
    const room = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
    if (!room) return reply.code(404).send({ error: 'not_found' });
    if (room.status !== 'open') return reply.code(400).send({ error: 'not_open' });
    if (room.tournament_id) return reply.code(400).send({ error: 'tournament_match' });
    if (room.creator_tg_id === user.tg_id) {
      db.prepare('DELETE FROM games WHERE id = ?').run(id);
      return { ok: true, deleted: true };
    }
    db.prepare('DELETE FROM game_players WHERE game_id = ? AND tg_id = ?').run(id, user.tg_id);
    return { ok: true };
  });

  // Pick a hero (canonical or custom). Pass hero_id OR hero_custom, not both.
  app.post('/:id/select-hero', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const { hero_id, hero_custom } = req.body || {};
    const db = getDb();
    const id = Number(req.params.id);
    const room = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
    if (!room) return reply.code(404).send({ error: 'not_found' });
    if (room.status !== 'open') return reply.code(400).send({ error: 'not_open' });
    if (!db.prepare('SELECT 1 FROM game_players WHERE game_id = ? AND tg_id = ?').get(id, user.tg_id)) {
      return reply.code(400).send({ error: 'not_in_room' });
    }
    const heroIdNum = hero_id ? Number(hero_id) : null;
    const custom = (typeof hero_custom === 'string' && hero_custom.trim())
      ? hero_custom.trim().slice(0, 64) : null;
    db.prepare(
      'UPDATE game_players SET hero_id = ?, hero_custom = ? WHERE game_id = ? AND tg_id = ?'
    ).run(heroIdNum, heroIdNum ? null : custom, id, user.tg_id);
    return { ok: true };
  });

  // Switch team (2v2 only)
  app.post('/:id/team', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const teamNum = Number(req.body?.team);
    if (teamNum !== 0 && teamNum !== 1) return reply.code(400).send({ error: 'invalid_team' });
    const db = getDb();
    const id = Number(req.params.id);
    const room = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
    if (!room) return reply.code(404).send({ error: 'not_found' });
    if (room.type !== '2v2') return reply.code(400).send({ error: 'not_team_game' });
    if (room.status !== 'open') return reply.code(400).send({ error: 'not_open' });
    const cur = db.prepare('SELECT team FROM game_players WHERE game_id = ? AND tg_id = ?').get(id, user.tg_id);
    if (!cur) return reply.code(400).send({ error: 'not_in_room' });
    if (cur.team !== teamNum) {
      const targetCount = db.prepare(
        'SELECT COUNT(*) AS n FROM game_players WHERE game_id = ? AND team = ?'
      ).get(id, teamNum).n;
      if (targetCount >= 2) return reply.code(400).send({ error: 'team_full' });
    }
    db.prepare('UPDATE game_players SET team = ? WHERE game_id = ? AND tg_id = ?').run(teamNum, id, user.tg_id);
    return { ok: true };
  });

  // Finalize: only creator. Body: { players: [{tg_id, team?, elimination_order?}], notes? }
  // Server validates with scoring engine and writes points.
  app.post('/:id/finalize', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const { players: resultPlayers, notes } = req.body || {};
    if (!Array.isArray(resultPlayers)) return reply.code(400).send({ error: 'invalid_payload' });
    const db = getDb();
    const id = Number(req.params.id);
    const room = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
    if (!room) return reply.code(404).send({ error: 'not_found' });
    if (room.status === 'finished') return reply.code(400).send({ error: 'already_finished' });
    if (room.creator_tg_id !== user.tg_id) return reply.code(403).send({ error: 'not_creator' });
    if (resultPlayers.length !== PLAYER_COUNT[room.type]) {
      return reply.code(400).send({ error: 'wrong_player_count' });
    }
    const inRoom = new Set(
      db.prepare('SELECT tg_id FROM game_players WHERE game_id = ?').all(id).map((r) => r.tg_id)
    );
    for (const p of resultPlayers) {
      if (!inRoom.has(p.tg_id)) {
        return reply.code(400).send({ error: 'unknown_player', tg_id: p.tg_id });
      }
    }

    let computed;
    try {
      computed = computePoints({ type: room.type, players: resultPlayers });
    } catch (e) {
      return reply.code(400).send({ error: 'invalid_result', detail: e.message });
    }

    transaction(db, () => {
      const upd = db.prepare(`
        UPDATE game_players
        SET elimination_order = ?, is_winner = ?, points_awarded = ?, team = COALESCE(?, team)
        WHERE game_id = ? AND tg_id = ?
      `);
      for (const r of resultPlayers) {
        const c = computed.find((x) => x.tg_id === r.tg_id);
        upd.run(
          r.elimination_order ?? null,
          c.is_winner,
          c.points_awarded,
          r.team ?? null,
          id,
          r.tg_id,
        );
      }
      db.prepare(
        "UPDATE games SET status = 'finished', finished_at = ?, notes = ? WHERE id = ?"
      ).run(Date.now(), typeof notes === 'string' ? notes.slice(0, 200) : null, id);
    });

    return { ok: true, results: computed };
  });
}
