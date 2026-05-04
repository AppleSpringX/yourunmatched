import { getDb, transaction } from '../db.js';
import { config } from '../config.js';

// Admin actions are gated by a shared secret in env (ADMIN_TOKEN).
// Pass it as either header `x-admin-token` or query `?token=...`.
function checkAdminToken(req) {
  if (!config.adminToken) return false;
  const fromHeader = req.headers['x-admin-token'];
  const fromQuery = req.query?.token;
  return fromHeader === config.adminToken || fromQuery === config.adminToken;
}

export async function adminRoutes(app) {
  // Soft reset: wipe game/tournament history, keep user accounts intact.
  // Returns row counts deleted from each table.
  app.post('/wipe-stats', async (req, reply) => {
    if (!checkAdminToken(req)) return reply.code(403).send({ error: 'forbidden' });
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

  // Hard reset: also clears users (their sig hero, custom deck, avatar, privacy).
  // After this, players need to re-open the bot to register again.
  app.post('/wipe-all', async (req, reply) => {
    if (!checkAdminToken(req)) return reply.code(403).send({ error: 'forbidden' });
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
}
