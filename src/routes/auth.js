import { verifyInitData, upsertUser, setSession } from '../auth.js';
import { getTopThreeRanks } from '../db.js';

export async function authRoutes(app) {
  app.post('/telegram', async (req, reply) => {
    const { initData } = req.body || {};
    const tgUser = verifyInitData(initData);
    if (!tgUser) return reply.code(401).send({ error: 'invalid_init_data' });
    const user = upsertUser(tgUser);
    setSession(reply, user.tg_id);
    const rank = getTopThreeRanks().get(user.tg_id) ?? null;
    return { ok: true, user: { ...user, rank } };
  });
}
