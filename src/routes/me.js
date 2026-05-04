import { requireAuth } from '../auth.js';
import { getDb } from '../db.js';

export async function meRoutes(app) {
  app.get('/', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;
    return { user: enrich(user) };
  });

  app.put('/', async (req, reply) => {
    const user = requireAuth(req, reply);
    if (!user) return;

    const { display_name, signature_hero_id, signature_custom } = req.body || {};
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

    const updated = db.prepare('SELECT * FROM users WHERE tg_id = ?').get(user.tg_id);
    return { user: enrich(updated) };
  });
}

function enrich(user) {
  if (!user.signature_hero_id) return user;
  const db = getDb();
  const hero = db.prepare('SELECT id, name, slug, set_name FROM heroes WHERE id = ?').get(user.signature_hero_id);
  return { ...user, hero };
}
