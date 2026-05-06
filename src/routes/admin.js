import { getDb, transaction } from '../db.js';
import { config } from '../config.js';
import { requireAuth, isAdminUser } from '../auth.js';

// Admin actions accept either a shared secret (X-Admin-Token header) or a
// session cookie from a user whose Telegram username matches ADMIN_USERNAMES.
function checkAdmin(req) {
  // 1) Token-based (used by curl from outside)
  if (config.adminToken) {
    const fromHeader = req.headers['x-admin-token'];
    const fromQuery = req.query?.token;
    if (fromHeader === config.adminToken || fromQuery === config.adminToken) return true;
  }
  // 2) Session-based (used by the Mini App when an admin is logged in)
  const cookie = req.cookies?.sid ? req.unsignCookie(req.cookies.sid) : null;
  const tgId = cookie?.valid ? Number(cookie.value) : null;
  if (tgId) {
    const user = getDb().prepare('SELECT * FROM users WHERE tg_id = ?').get(tgId);
    if (user && isAdminUser(user)) return true;
  }
  return false;
}

export async function adminRoutes(app) {
  // Soft reset: wipe game/tournament history, keep user accounts intact.
  app.post('/wipe-stats', async (req, reply) => {
    if (!checkAdmin(req)) return reply.code(403).send({ error: 'forbidden' });
    const db = getDb();
    let counts;
    transaction(db, () => {
      const gp = db.prepare('DELETE FROM game_players').run();
      const g = db.prepare('DELETE FROM games').run();
      const tp = db.prepare('DELETE FROM tournament_players').run();
      const t = db.prepare('DELETE FROM tournaments').run();
      counts = {
        game_players: gp.changes,
        games: g.changes,
        tournament_players: tp.changes,
        tournaments: t.changes,
      };
    });
    console.log('[admin] wipe-stats:', counts);
    return { ok: true, deleted: counts };
  });

  // Hard reset: also clears users.
  app.post('/wipe-all', async (req, reply) => {
    if (!checkAdmin(req)) return reply.code(403).send({ error: 'forbidden' });
    const db = getDb();
    let counts;
    transaction(db, () => {
      const gp = db.prepare('DELETE FROM game_players').run();
      const g = db.prepare('DELETE FROM games').run();
      const tp = db.prepare('DELETE FROM tournament_players').run();
      const t = db.prepare('DELETE FROM tournaments').run();
      const u = db.prepare('DELETE FROM users').run();
      counts = {
        users: u.changes,
        game_players: gp.changes,
        games: g.changes,
        tournament_players: tp.changes,
        tournaments: t.changes,
      };
    });
    console.log('[admin] wipe-all:', counts);
    return { ok: true, deleted: counts };
  });

  // Edit any user's profile — admin overrides what the user themselves can edit on /me.
  app.put('/user/:tg_id', async (req, reply) => {
    if (!checkAdmin(req)) return reply.code(403).send({ error: 'forbidden' });
    const tgId = Number(req.params.tg_id);
    const { display_name, signature_hero_id, signature_custom, privacy } = req.body || {};
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgId);
    if (!user) return reply.code(404).send({ error: 'not_found' });

    if (typeof display_name === 'string' && display_name.trim().length > 0) {
      db.prepare('UPDATE users SET display_name = ? WHERE tg_id = ?').run(
        display_name.trim().slice(0, 64), tgId,
      );
    }
    if (signature_hero_id !== undefined) {
      const heroId = signature_hero_id ? Number(signature_hero_id) : null;
      db.prepare('UPDATE users SET signature_hero_id = ?, signature_custom = NULL WHERE tg_id = ?').run(heroId, tgId);
    } else if (typeof signature_custom === 'string') {
      db.prepare('UPDATE users SET signature_hero_id = NULL, signature_custom = ? WHERE tg_id = ?')
        .run(signature_custom.trim().slice(0, 64) || null, tgId);
    }
    if (privacy && typeof privacy === 'object') {
      const fields = ['show_breakdown', 'show_heroes', 'show_recent'];
      for (const k of fields) {
        if (typeof privacy[k] === 'boolean') {
          db.prepare(`UPDATE users SET ${k} = ? WHERE tg_id = ?`).run(privacy[k] ? 1 : 0, tgId);
        }
      }
    }

    const updated = db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgId);
    return { ok: true, user: updated };
  });

  // Delete a user. Their game_players rows cascade-delete. Created rooms become orphaned
  // (creator_tg_id will reference a deleted user) — we handle that by deleting their
  // open rooms outright, and unlinking their finished games (set creator_tg_id to NULL
  // would violate FK; safer to delete tournament-link, leave the games as historical).
  app.post('/user/:tg_id/delete', async (req, reply) => {
    if (!checkAdmin(req)) return reply.code(403).send({ error: 'forbidden' });
    const tgId = Number(req.params.tg_id);
    const db = getDb();
    const user = db.prepare('SELECT tg_id FROM users WHERE tg_id = ?').get(tgId);
    if (!user) return reply.code(404).send({ error: 'not_found' });

    let summary;
    transaction(db, () => {
      // 1) Find rooms this user created
      const myRooms = db.prepare('SELECT id, status FROM games WHERE creator_tg_id = ?').all(tgId);
      // Open rooms — delete entirely (player rows cascade)
      const openRoomIds = myRooms.filter((r) => r.status === 'open').map((r) => r.id);
      for (const id of openRoomIds) {
        db.prepare('DELETE FROM games WHERE id = ?').run(id);
      }
      // Finished rooms — keep, but reassign creator_tg_id to a sentinel? FK doesn't allow null
      // unless we make it nullable. For now, refuse to delete a user with finished games as creator.
      const remainingFinished = db.prepare(
        "SELECT COUNT(*) AS n FROM games WHERE creator_tg_id = ? AND status = 'finished'"
      ).get(tgId).n;
      if (remainingFinished > 0) {
        throw new Error(`user has ${remainingFinished} finished games as creator — delete or detach them first`);
      }
      // Tournaments created by this user — same constraint
      const tCount = db.prepare('SELECT COUNT(*) AS n FROM tournaments WHERE creator_tg_id = ?').get(tgId).n;
      if (tCount > 0) {
        throw new Error(`user has ${tCount} tournaments as creator — delete them first`);
      }

      // Remove participation rows + tournament memberships
      const gp = db.prepare('DELETE FROM game_players WHERE tg_id = ?').run(tgId);
      const tp = db.prepare('DELETE FROM tournament_players WHERE tg_id = ?').run(tgId);
      const u = db.prepare('DELETE FROM users WHERE tg_id = ?').run(tgId);

      summary = {
        deleted_open_rooms: openRoomIds.length,
        deleted_game_players: gp.changes,
        deleted_tournament_players: tp.changes,
        deleted_user: u.changes,
      };
    });
    console.log('[admin] user-delete', tgId, summary);
    return { ok: true, ...summary };
  });

  // Force-delete a room regardless of state (open or finished) — strips its history.
  app.post('/room/:id/delete', async (req, reply) => {
    if (!checkAdmin(req)) return reply.code(403).send({ error: 'forbidden' });
    const id = Number(req.params.id);
    const db = getDb();
    const r = db.prepare('SELECT id FROM games WHERE id = ?').get(id);
    if (!r) return reply.code(404).send({ error: 'not_found' });
    db.prepare('DELETE FROM games WHERE id = ?').run(id);
    return { ok: true };
  });
}
