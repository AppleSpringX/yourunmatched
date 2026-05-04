import { verifyInitData, upsertUser, setSession } from '../auth.js';

export async function authRoutes(app) {
  app.post('/telegram', async (req, reply) => {
    const { initData } = req.body || {};
    const tgUser = verifyInitData(initData);
    if (!tgUser) return reply.code(401).send({ error: 'invalid_init_data' });
    const user = upsertUser(tgUser);
    setSession(reply, user.tg_id);
    return { ok: true, user };
  });
}
