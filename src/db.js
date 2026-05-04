import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db;

export function getDb() {
  if (!db) initDb();
  return db;
}

export function initDb() {
  if (db) return db;
  const dbDir = dirname(resolve(config.dbPath));
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

  db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  migrate(db);
  seedHeroes(db);
  return db;
}

// node:sqlite has no built-in transaction helper; thin wrapper for clarity.
export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      tg_id INTEGER PRIMARY KEY,
      username TEXT,
      display_name TEXT NOT NULL,
      signature_hero_id INTEGER REFERENCES heroes(id),
      signature_custom TEXT,
      avatar_file_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS heroes (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      set_name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS tournaments (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      format TEXT NOT NULL CHECK(format IN ('round_robin')),
      game_type TEXT NOT NULL CHECK(game_type IN ('1v1','2v2','ffa3','ffa4')),
      creator_tg_id INTEGER NOT NULL REFERENCES users(tg_id),
      status TEXT NOT NULL CHECK(status IN ('open','in_progress','finished')),
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('1v1','2v2','ffa3','ffa4')),
      tournament_id INTEGER REFERENCES tournaments(id),
      creator_tg_id INTEGER NOT NULL REFERENCES users(tg_id),
      status TEXT NOT NULL CHECK(status IN ('open','in_progress','finished')),
      notes TEXT,
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS game_players (
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      tg_id INTEGER NOT NULL REFERENCES users(tg_id),
      team INTEGER,
      hero_id INTEGER REFERENCES heroes(id),
      hero_custom TEXT,
      elimination_order INTEGER,
      is_winner INTEGER NOT NULL DEFAULT 0,
      points_awarded INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (game_id, tg_id)
    );

    CREATE INDEX IF NOT EXISTS idx_games_type_status ON games(type, status);
    CREATE INDEX IF NOT EXISTS idx_game_players_tg ON game_players(tg_id);
    CREATE INDEX IF NOT EXISTS idx_games_tournament ON games(tournament_id);
  `);
}

function seedHeroes(db) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM heroes').get().n;
  if (count > 0) return;

  const seedPath = resolve(__dirname, 'data', 'heroes.json');
  const heroes = JSON.parse(readFileSync(seedPath, 'utf8'));

  const insert = db.prepare(
    'INSERT INTO heroes (name, set_name, slug) VALUES (?, ?, ?)'
  );
  transaction(db, () => {
    for (const h of heroes) insert.run(h.name, h.set, h.slug);
  });
  console.log(`[db] seeded ${heroes.length} heroes`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  initDb();
  console.log('[db] migration complete');
}
