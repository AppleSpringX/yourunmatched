// Rooms = games in 'open'/'in_progress' state.
// Implementation arrives in the next pass; this stub keeps the server bootable.

export async function roomsRoutes(app) {
  app.get('/', async () => ({ rooms: [], todo: 'list-open-rooms' }));
  app.post('/', async (req, reply) => reply.code(501).send({ error: 'not_implemented' }));
  app.get('/:id', async (req, reply) => reply.code(501).send({ error: 'not_implemented' }));
  app.post('/:id/join', async (req, reply) => reply.code(501).send({ error: 'not_implemented' }));
  app.post('/:id/leave', async (req, reply) => reply.code(501).send({ error: 'not_implemented' }));
  app.post('/:id/select-hero', async (req, reply) => reply.code(501).send({ error: 'not_implemented' }));
  app.post('/:id/finalize', async (req, reply) => reply.code(501).send({ error: 'not_implemented' }));
}
