import { getDb, getTopThreeRanks, transaction } from '../db.js';
import { requireAuth } from '../auth.js';
import { computePoints, PLAYER_COUNT } from '../scoring.js';
import { notify, notifyRoom } from '../notify.js';

// — draft helpers —

// Player turn order for the draft.
// 2v2 alternates teams (A1, B1, A2, B2). 1v1 / FFA use plain join order.
function draftPlayerOrder(players, type) {
  if (type === '2v2') {
    const t0 = players.filter((p) => p.team === 0);
    const t1 = players.filter((p) => p.team === 1);
    const max = Math.max(t0.length, t1.length);
    const out = [];
    for (let i = 0; i < max; i++) {
      if (t0[i]) out.push(t0[i]);
      if (t1[i]) out.push(t1[i]);
    }
    return out;
  }
  return players;
}

// Computes draft state for a room. Returns null if draft mode not enabled.
function draftState(room, players) {
  if (!room.is_draft) return null;
  const log = JSON.parse(room.draft_log || '[]');
  const ordered = draftPlayerOrder(players, room.type);
  const N = ordered.length;
  const total = 2 * N;
  const banned = log.filter((a) => a.action === 'ban').map((a) => a.hero_id);
  const picks = log.filter((a) => a.action === 'pick').map((a) => ({ tg_id: a.tg_id, hero_id: a.hero_id }));
  const complete = log.length >= total;
  const started = !!room.draft_started_at;

  let currentTurn = null;
  let currentAction = null;
  if (started && !complete) {
    currentAction = log.length < N ? 'ban' : 'pick';
    currentTurn = ordered[log.length % N]?.tg_id ?? null;
  }

  return {
    started,
    complete,
    pool: JSON.parse(room.hero_pool || '[]'),
    banned,
    picks,
    log,
    total,
    done: log.length,
    currentTurn,
    currentAction,
    order: ordered.map((p) => p.tg_id),
  };
}

// — routes —

export async function roomsRoutes(app) {
  // List open rooms
  app.get('/', async (req, reply) => {
    if (!requireAuth(req, reply)) return;
    const db = getDb();
    const rooms = db.prepare(`
      SELECT g.id, g.type, g.creator_tg_id, g.notes, g.created_at, g.tournament_id,
             g.is_draft,
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

  // Create a room. Optional draft mode with hero_pool (array of hero ids).
  app.post('/', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const { type, is_draft, hero_pool } = req.body || {};
    if (!PLAYER_COUNT[type]) return reply.code(400).send({ error: 'invalid_type' });

    const isDraft = !!is_draft;
    let poolJson = null;
    if (isDraft) {
      const minPool = 2 * PLAYER_COUNT[type];
      if (!Array.isArray(hero_pool)) return reply.code(400).send({ error: 'invalid_pool' });
      const pool = [...new Set(hero_pool.map(Number).filter(Number.isFinite))];
      if (pool.length < minPool) {
        return reply.code(400).send({ error: 'pool_too_small', needed: minPool });
      }
      // Validate hero ids exist
      const db = getDb();
      const placeholders = pool.map(() => '?').join(',');
      const found = db.prepare(`SELECT COUNT(*) AS n FROM heroes WHERE id IN (${placeholders})`).get(...pool).n;
      if (found !== pool.length) return reply.code(400).send({ error: 'unknown_hero_in_pool' });
      poolJson = JSON.stringify(pool);
    }

    const db = getDb();
    let roomId;
    transaction(db, () => {
      const r = db.prepare(`
        INSERT INTO games (type, creator_tg_id, status, created_at, is_draft, hero_pool)
        VALUES (?, ?, 'open', ?, ?, ?)
      `).run(type, user.tg_id, Date.now(), isDraft ? 1 : 0, poolJson);
      roomId = Number(r.lastInsertRowid);
      const team = type === '2v2' ? 0 : null;
      db.prepare(
        'INSERT INTO game_players (game_id, tg_id, team) VALUES (?, ?, ?)'
      ).run(roomId, user.tg_id, team);
    });
    return { id: roomId };
  });

  // Room detail with participants + draft state if applicable
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
      ORDER BY gp.rowid ASC
    `).all(room.id);
    const ranks = getTopThreeRanks();
    for (const p of players) p.rank = ranks.get(p.tg_id) ?? null;
    const draft = draftState(room, players);
    return {
      room: {
        ...room,
        is_draft: !!room.is_draft,
        players,
        target_count: PLAYER_COUNT[room.type],
        draft,
      },
    };
  });

  // Join (not allowed for tournament matches — fixed roster)
  app.post('/:id/join', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const db = getDb();
    const id = Number(req.params.id);
    const room = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
    if (!room) return reply.code(404).send({ error: 'not_found' });
    if (room.status !== 'open') return reply.code(400).send({ error: 'not_open' });
    if (room.tournament_id) return reply.code(400).send({ error: 'tournament_match' });
    if (room.draft_started_at) return reply.code(400).send({ error: 'draft_in_progress' });
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

    // Tell the creator someone joined (only if not the creator joining their own room).
    if (room.creator_tg_id !== user.tg_id) {
      const newCount = count + 1;
      const remaining = PLAYER_COUNT[room.type] - newCount;
      const status = remaining > 0
        ? `${user.display_name || 'Игрок'} зашёл — ждём ещё ${remaining}`
        : `${user.display_name || 'Игрок'} зашёл — комната заполнена 🔥`;
      notifyRoom(room.creator_tg_id, status, id);
    }
    return { ok: true };
  });

  // Leave (creator-leave deletes the room)
  app.post('/:id/leave', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const db = getDb();
    const id = Number(req.params.id);
    const room = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
    if (!room) return reply.code(404).send({ error: 'not_found' });
    if (room.status !== 'open') return reply.code(400).send({ error: 'not_open' });
    if (room.tournament_id) return reply.code(400).send({ error: 'tournament_match' });
    if (room.draft_started_at) return reply.code(400).send({ error: 'draft_in_progress' });
    if (room.creator_tg_id === user.tg_id) {
      db.prepare('DELETE FROM games WHERE id = ?').run(id);
      return { ok: true, deleted: true };
    }
    db.prepare('DELETE FROM game_players WHERE game_id = ? AND tg_id = ?').run(id, user.tg_id);
    return { ok: true };
  });

  // Manual hero pick (non-draft mode). In draft mode, picks come via /draft-action.
  app.post('/:id/select-hero', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const { hero_id, hero_custom } = req.body || {};
    const db = getDb();
    const id = Number(req.params.id);
    const room = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
    if (!room) return reply.code(404).send({ error: 'not_found' });
    if (room.status !== 'open') return reply.code(400).send({ error: 'not_open' });
    if (room.draft_started_at) return reply.code(400).send({ error: 'draft_in_progress' });
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

  // Switch team (2v2 only, before draft starts)
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
    if (room.draft_started_at) return reply.code(400).send({ error: 'draft_in_progress' });
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

  // Start the draft (host only). Randomizes 2v2 teams. Resets draft_log.
  app.post('/:id/start-draft', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const db = getDb();
    const id = Number(req.params.id);
    const room = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
    if (!room) return reply.code(404).send({ error: 'not_found' });
    if (!room.is_draft) return reply.code(400).send({ error: 'not_draft_mode' });
    if (room.creator_tg_id !== user.tg_id) return reply.code(403).send({ error: 'not_creator' });
    if (room.draft_started_at) return reply.code(400).send({ error: 'already_started' });
    if (room.status !== 'open') return reply.code(400).send({ error: 'not_open' });

    const players = db.prepare('SELECT * FROM game_players WHERE game_id = ? ORDER BY rowid').all(id);
    if (players.length !== PLAYER_COUNT[room.type]) {
      return reply.code(400).send({ error: 'not_full' });
    }

    transaction(db, () => {
      // Randomize 2v2 teams (player order on roster is preserved; we just reassign team labels)
      if (room.type === '2v2') {
        const shuffled = [...players].sort(() => Math.random() - 0.5);
        const upd = db.prepare('UPDATE game_players SET team = ? WHERE game_id = ? AND tg_id = ?');
        shuffled.forEach((p, i) => upd.run(i < 2 ? 0 : 1, id, p.tg_id));
      }
      db.prepare('UPDATE games SET draft_started_at = ?, draft_log = ? WHERE id = ?')
        .run(Date.now(), '[]', id);
    });

    // Notify first picker that their ban turn just started.
    const fresh = db.prepare('SELECT * FROM game_players WHERE game_id = ? ORDER BY rowid').all(id);
    const order = draftPlayerOrder(fresh, room.type);
    if (order[0]) {
      notifyRoom(order[0].tg_id, '🎲 Драфт начался — твой ход: бан', id);
    }

    return { ok: true };
  });

  // Draft action: ban or pick a hero (current player only, expected phase)
  app.post('/:id/draft-action', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const { action, hero_id } = req.body || {};
    if (action !== 'ban' && action !== 'pick') return reply.code(400).send({ error: 'invalid_action' });
    const heroIdNum = Number(hero_id);
    if (!Number.isFinite(heroIdNum)) return reply.code(400).send({ error: 'invalid_hero' });

    const db = getDb();
    const id = Number(req.params.id);
    const room = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
    if (!room) return reply.code(404).send({ error: 'not_found' });
    if (!room.is_draft) return reply.code(400).send({ error: 'not_draft_mode' });
    if (!room.draft_started_at) return reply.code(400).send({ error: 'draft_not_started' });
    if (room.status !== 'open') return reply.code(400).send({ error: 'not_open' });

    const players = db.prepare('SELECT * FROM game_players WHERE game_id = ? ORDER BY rowid').all(id);
    const ordered = draftPlayerOrder(players, room.type);
    const log = JSON.parse(room.draft_log || '[]');
    const N = ordered.length;
    if (log.length >= 2 * N) return reply.code(400).send({ error: 'draft_complete' });

    const expectedPhase = log.length < N ? 'ban' : 'pick';
    if (action !== expectedPhase) {
      return reply.code(400).send({ error: 'wrong_phase', expected: expectedPhase });
    }

    const playerIdx = log.length % N;
    if (ordered[playerIdx].tg_id !== user.tg_id) {
      return reply.code(403).send({ error: 'not_your_turn' });
    }

    const pool = JSON.parse(room.hero_pool || '[]');
    if (!pool.includes(heroIdNum)) return reply.code(400).send({ error: 'not_in_pool' });
    if (log.some((a) => a.hero_id === heroIdNum)) return reply.code(400).send({ error: 'hero_used' });

    log.push({ tg_id: user.tg_id, action, hero_id: heroIdNum, ts: Date.now() });
    transaction(db, () => {
      db.prepare('UPDATE games SET draft_log = ? WHERE id = ?').run(JSON.stringify(log), id);
      if (action === 'pick') {
        db.prepare(
          'UPDATE game_players SET hero_id = ?, hero_custom = NULL WHERE game_id = ? AND tg_id = ?'
        ).run(heroIdNum, id, user.tg_id);
      }
    });

    // Notifications: nudge the next picker, or congratulate everyone on draft completion.
    const total = 2 * N;
    if (log.length < total) {
      const nextIdx = log.length % N;
      const nextPhase = log.length < N ? 'бан' : 'пик';
      const nextPlayer = ordered[nextIdx];
      if (nextPlayer && nextPlayer.tg_id !== user.tg_id) {
        notifyRoom(nextPlayer.tg_id, `🎲 Твой ход в драфте: ${nextPhase}`, id);
      }
    } else {
      for (const p of ordered) {
        notifyRoom(p.tg_id, '✅ Драфт завершён — герои выбраны, ждите результата от хоста.', id);
      }
    }

    return { ok: true };
  });

  // Reset finalized results: creator-only, returns a finished room to 'open' state.
  // Wipes elimination order / winners / points so points come off everyone's totals.
  // Hero selections, teams, draft state are kept — host just re-records the result.
  app.post('/:id/reset-results', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const db = getDb();
    const id = Number(req.params.id);
    const room = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
    if (!room) return reply.code(404).send({ error: 'not_found' });
    if (room.creator_tg_id !== user.tg_id) return reply.code(403).send({ error: 'not_creator' });
    if (room.status !== 'finished') return reply.code(400).send({ error: 'not_finished' });

    transaction(db, () => {
      db.prepare(`
        UPDATE game_players
        SET elimination_order = NULL, is_winner = 0, points_awarded = 0
        WHERE game_id = ?
      `).run(id);
      db.prepare(
        "UPDATE games SET status = 'open', finished_at = NULL, notes = NULL WHERE id = ?"
      ).run(id);
    });
    return { ok: true };
  });

  // Cancel an active draft: clears bans/picks and per-player hero ids, returns to lobby.
  // Useful if host realizes pool is wrong, picks went sideways, etc.
  app.post('/:id/cancel-draft', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    const db = getDb();
    const id = Number(req.params.id);
    const room = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
    if (!room) return reply.code(404).send({ error: 'not_found' });
    if (room.creator_tg_id !== user.tg_id) return reply.code(403).send({ error: 'not_creator' });
    if (!room.is_draft) return reply.code(400).send({ error: 'not_draft_mode' });
    if (!room.draft_started_at) return reply.code(400).send({ error: 'draft_not_started' });
    if (room.status !== 'open') return reply.code(400).send({ error: 'not_open' });

    transaction(db, () => {
      db.prepare(
        'UPDATE game_players SET hero_id = NULL, hero_custom = NULL WHERE game_id = ?'
      ).run(id);
      db.prepare(
        "UPDATE games SET draft_started_at = NULL, draft_log = '[]' WHERE id = ?"
      ).run(id);
    });
    return { ok: true };
  });

  // Finalize: only creator. Body: { players: [{tg_id, team?, elimination_order?}], notes? }
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

    // Notify each player with their result.
    for (const c of computed) {
      const verb = c.is_winner ? '🏆 Победа' : '💀 Поражение';
      notifyRoom(c.tg_id, `${verb} · +${c.points_awarded} очков`, id);
    }

    return { ok: true, results: computed };
  });
}
