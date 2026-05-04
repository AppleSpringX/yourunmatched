import { authRoutes } from './auth.js';
import { meRoutes } from './me.js';
import { heroesRoutes } from './heroes.js';
import { playersRoutes } from './players.js';
import { roomsRoutes } from './rooms.js';
import { tournamentsRoutes } from './tournaments.js';
import { avatarRoutes } from './avatar.js';
import { adminRoutes } from './admin.js';

export function registerRoutes(app) {
  app.register(authRoutes, { prefix: '/api/auth' });
  app.register(meRoutes, { prefix: '/api/me' });
  app.register(heroesRoutes, { prefix: '/api/heroes' });
  app.register(playersRoutes, { prefix: '/api/players' });
  app.register(roomsRoutes, { prefix: '/api/rooms' });
  app.register(tournamentsRoutes, { prefix: '/api/tournaments' });
  app.register(avatarRoutes, { prefix: '/api/avatar' });
  app.register(adminRoutes, { prefix: '/api/admin' });
}
