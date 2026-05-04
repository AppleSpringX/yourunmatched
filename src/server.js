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
