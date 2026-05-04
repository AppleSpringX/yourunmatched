import { getDb } from '../db.js';

export async function heroesRoutes(app) {
  app.get('/', async () => {
    const db = getDb();
    const heroes = db.prepare('SELECT id, name, slug, set_name FROM heroes ORDER BY set_name, name').all();
    return { heroes };
  });
}
