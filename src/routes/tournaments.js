// Tournaments stub. Round-robin generation lands in a later step.

export async function tournamentsRoutes(app) {
  app.get('/', async () => ({ tournaments: [] }));
  app.post('/', async (req, reply) => reply.code(501).send({ error: 'not_implemented' }));
  app.get('/:id', async (req, reply) => reply.code(501).send({ error: 'not_implemented' }));
}
