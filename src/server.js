import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';
import { initDb } from './db.js';
import { startBot } from './bot.js';
import { registerRoutes } from './routes/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, '..', 'public');

const app = Fastify({ logger: { level: 'info' } });

await app.register(fastifyCookie, { secret: config.sessionSecret });
await app.register(fastifyStatic, {
  root: publicDir,
  prefix: '/',
  // No long-term caching during active development — ETag/If-None-Match still avoids transfer.
  cacheControl: true,
  maxAge: 0,
  etag: true,
  lastModified: true,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  },
});

initDb();
registerRoutes(app);

app.get('/healthz', async () => ({ ok: true }));

const bot = await startBot(app);
if (bot && config.botMode === 'webhook') {
  app.post('/bot/webhook', async (req, reply) => {
    await bot.handleUpdate(req.body);
    reply.code(200).send();
  });
}

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`Server listening on :${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Render free tier sleeps after 15 min of no inbound traffic. Bot is always-on
// here on wispbyte, so we ping the public WEBAPP_URL every 14 minutes to keep
// the proxy warm. Cheap and reliable — no external pinger needed.
if (config.webappUrl && /^https?:\/\//.test(config.webappUrl)) {
  const PING_INTERVAL_MS = 14 * 60 * 1000;
  const pingUrl = config.webappUrl.replace(/\/$/, '') + '/proxy-health';
  const ping = async () => {
    try {
      const res = await fetch(pingUrl, { method: 'GET' });
      app.log.debug(`[keepalive] ${pingUrl} -> ${res.status}`);
    } catch (err) {
      app.log.debug(`[keepalive] ${pingUrl} failed: ${err.message}`);
    }
  };
  // Fire once on boot (after a short delay to let the proxy come up too) and then on interval.
  setTimeout(ping, 30_000);
  setInterval(ping, PING_INTERVAL_MS);
  app.log.info(`[keepalive] pinging ${pingUrl} every ${PING_INTERVAL_MS / 60000} min`);
}
