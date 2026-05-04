import { createHmac } from 'node:crypto';
import { config } from './config.js';
import { getDb } from './db.js';

const SESSION_COOKIE = 'sid';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

export function verifyInitData(initData) {
  if (!initData || !config.botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(config.botToken).digest();
  const computed = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computed !== hash) return null;

  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;

  const userJson = params.get('user');
  if (!userJson) return null;
  return JSON.parse(userJson);
}

export function upsertUser(tgUser) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgUser.id);
  const displayName = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ').trim()
    || tgUser.username
    || `Player ${tgUser.id}`;

  if (existing) {
    db.prepare('UPDATE users SET username = ? WHERE tg_id = ?').run(tgUser.username || null, tgUser.id);
    return existing;
  }

  db.prepare(
    'INSERT INTO users (tg_id, username, display_name, created_at) VALUES (?, ?, ?, ?)'
  ).run(tgUser.id, tgUser.username || null, displayName, Date.now());

  return db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgUser.id);
}

export function setSession(reply, tgId) {
  reply.setCookie(SESSION_COOKIE, String(tgId), {
    signed: true,
    httpOnly: true,
    sameSite: 'none',
    secure: true,
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function getSessionUserId(req) {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid) return null;
  return Number(unsigned.value);
}

export function requireAuth(req, reply) {
  const tgId = getSessionUserId(req);
  if (!tgId) {
    reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgId);
  if (!user) {
    reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
  return user;
}
