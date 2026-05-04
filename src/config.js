import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

function loadDotenv() {
  const path = resolve(process.cwd(), '.env');
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotenv();

// Pterodactyl/wispbyte expose the allocated port as SERVER_PORT, not PORT.
const port = Number(process.env.SERVER_PORT || process.env.PORT) || 3000;

export const config = {
  botToken: process.env.BOT_TOKEN || '',
  webappUrl: process.env.WEBAPP_URL || '',
  port,
  dbPath: process.env.DB_PATH || './data/unmatched.db',
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  botMode: process.env.BOT_MODE === 'webhook' ? 'webhook' : 'polling',
  webhookUrl: process.env.WEBHOOK_URL || '',
  adminToken: process.env.ADMIN_TOKEN || '',
};

if (!config.botToken) {
  console.warn('[config] BOT_TOKEN is empty — auth and bot will not work until set.');
}
