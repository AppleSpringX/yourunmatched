import { getDb, getTopThreeRanks } from '../db.js';

const SORT_FILTERS = {
  overall: '',
  '1v1': "AND g.type = '1v1'",
  '2v2': "AND g.type = '2v2'",
  ffa: "AND g.type IN ('ffa3','ffa4')",
};

export async function playersRoutes(app) {
  app.get('/', async (req) => {
    const sort = SORT_FILTERS[req.query.sort] !== undefined ? req.query.sort : 'overall';
    const filter = SORT_FILTERS[sort];
    const db = getDb();

    const rows = db.prepare(`
      SELECT
        u.tg_id,
        u.display_name,
        u.username,
        u.signature_hero_id,
        u.signature_custom,
        u.avatar_file_id,
        h.name AS hero_name,
        h.slug AS hero_slug,
        COALESCE(SUM(CASE WHEN gp.game_id IS NOT NULL ${filter} THEN gp.points_awarded ELSE 0 END), 0) AS points,
        COUNT(CASE WHEN gp.game_id IS NOT NULL ${filter} THEN 1 ELSE NULL END) AS games_played
      FROM users u
      LEFT JOIN heroes h ON h.id = u.signature_hero_id
      LEFT JOIN game_players gp ON gp.tg_id = u.tg_id
      LEFT JOIN games g ON g.id = gp.game_id AND g.status = 'finished'
      GROUP BY u.tg_id
    `).all();

    // Fold admin adjustments. Overall tab adds all categories; mode tabs only the matching category.
    const ADJ_CAT = { overall: null, '1v1': '1v1', '2v2': '2v2', ffa: 'ffa' };
    const adjCat = ADJ_CAT[sort];
    const adjRows = adjCat === null
      ? db.prepare('SELECT tg_id, SUM(delta) AS total FROM points_adjustments GROUP BY tg_id').all()
      : db.prepare('SELECT tg_id, SUM(delta) AS total FROM points_adjustments WHERE category = ? GROUP BY tg_id').all(adjCat);
    const adjByTgId = new Map(adjRows.map((r) => [r.tg_id, r.total]));
    for (const r of rows) {
      const adj = adjByTgId.get(r.tg_id) || 0;
      if (adj) r.points = (r.points || 0) + adj;
    }
    rows.sort((a, b) => (b.points - a.points)
      || (b.games_played - a.games_played)
      || a.display_name.localeCompare(b.display_name));

    const ranks = getTopThreeRanks();
    for (const r of rows) r.rank = ranks.get(r.tg_id) ?? null;

    return { sort, players: rows };
  });

  app.get('/:tg_id', async (req, reply) => {
    const tgId = Number(req.params.tg_id);
    const db = getDb();
    const user = db.prepare(`
      SELECT u.*, h.name AS hero_name, h.slug AS hero_slug
      FROM users u LEFT JOIN heroes h ON h.id = u.signature_hero_id
      WHERE u.tg_id = ?
    `).get(tgId);
    if (!user) return reply.code(404).send({ error: 'not_found' });

    user.rank = getTopThreeRanks().get(tgId) ?? null;

    // Privacy: profile owner sees everything; other viewers get only sections marked public.
    const viewerCookie = req.cookies?.sid ? req.unsignCookie(req.cookies.sid) : null;
    const viewerTgId = viewerCookie?.valid ? Number(viewerCookie.value) : null;
    const isOwner = viewerTgId === tgId;
    const canSeeBreakdown = isOwner || user.show_breakdown !== 0;
    const canSeeHeroes = isOwner || user.show_heroes !== 0;
    const canSeeRecent = isOwner || user.show_recent !== 0;

    // Head-to-head: pair stats between the viewer and this profile (all finished games where both played).
    let h2h = null;
    if (viewerTgId && !isOwner) {
      const matches = db.prepare(`
        SELECT g.type, g.finished_at,
               gp1.team AS my_team, gp1.elimination_order AS my_elim,
               gp2.team AS their_team, gp2.elimination_order AS their_elim
        FROM games g
        JOIN game_players gp1 ON gp1.game_id = g.id AND gp1.tg_id = ?
        JOIN game_players gp2 ON gp2.game_id = g.id AND gp2.tg_id = ?
        WHERE g.status = 'finished'
        ORDER BY g.finished_at DESC
      `).all(viewerTgId, tgId);

      let games = 0, my_wins = 0, their_wins = 0, last_meeting = null;
      for (const m of matches) {
        // Allies in 2v2 don't count as a head-to-head match.
        if (m.type === '2v2' && m.my_team === m.their_team) continue;
        games++;
        if (last_meeting === null) last_meeting = m.finished_at;
        // elimination_order: null = survived (best), 1 = first eliminated (worst). Bigger = better.
        const mine = m.my_elim === null ? Infinity : m.my_elim;
        const theirs = m.their_elim === null ? Infinity : m.their_elim;
        if (mine > theirs) my_wins++;
        else if (theirs > mine) their_wins++;
      }
      if (games > 0) h2h = { games, my_wins, their_wins, last_meeting };
    }

    const totals = db.prepare(`
      SELECT
        SUM(CASE WHEN g.type = '1v1' THEN gp.points_awarded ELSE 0 END) AS pts_1v1,
        SUM(CASE WHEN g.type = '2v2' THEN gp.points_awarded ELSE 0 END) AS pts_2v2,
        SUM(CASE WHEN g.type IN ('ffa3','ffa4') THEN gp.points_awarded ELSE 0 END) AS pts_ffa,
        SUM(gp.points_awarded) AS pts_overall,
        COUNT(*) AS games_played,
        SUM(gp.is_winner) AS wins
      FROM game_players gp
      JOIN games g ON g.id = gp.game_id
      WHERE gp.tg_id = ? AND g.status = 'finished'
    `).get(tgId);

    // Fold per-category admin adjustments into the breakdown. Each per-category adjustment
    // also flows into pts_overall (Overall == sum of all). 'overall'-only adjustments
    // affect pts_overall only.
    const adj = db.prepare(
      'SELECT category, COALESCE(SUM(delta), 0) AS total FROM points_adjustments WHERE tg_id = ? GROUP BY category'
    ).all(tgId);
    for (const row of adj) {
      totals.pts_overall = (totals.pts_overall || 0) + row.total;
      if (row.category === '1v1') totals.pts_1v1 = (totals.pts_1v1 || 0) + row.total;
      else if (row.category === '2v2') totals.pts_2v2 = (totals.pts_2v2 || 0) + row.total;
      else if (row.category === 'ffa') totals.pts_ffa = (totals.pts_ffa || 0) + row.total;
    }

    const heroStats = db.prepare(`
      SELECT
        COALESCE(h.name, gp.hero_custom) AS hero_name,
        h.slug AS hero_slug,
        COUNT(*) AS games,
        SUM(gp.is_winner) AS wins,
        SUM(gp.points_awarded) AS points
      FROM game_players gp
      JOIN games g ON g.id = gp.game_id
      LEFT JOIN heroes h ON h.id = gp.hero_id
      WHERE gp.tg_id = ? AND g.status = 'finished'
        AND (gp.hero_id IS NOT NULL OR gp.hero_custom IS NOT NULL)
      GROUP BY hero_name
      ORDER BY games DESC, wins DESC
    `).all(tgId);

    const recent = db.prepare(`
      SELECT g.id, g.type, g.finished_at, g.notes, gp.points_awarded, gp.is_winner,
             COALESCE(h.name, gp.hero_custom) AS hero_name
      FROM game_players gp
      JOIN games g ON g.id = gp.game_id
      LEFT JOIN heroes h ON h.id = gp.hero_id
      WHERE gp.tg_id = ? AND g.status = 'finished'
      ORDER BY g.finished_at DESC
      LIMIT 20
    `).all(tgId);

    // Overall points are always public; only the per-mode breakdown is gated by show_breakdown.
    const publicTotals = canSeeBreakdown
      ? totals
      : { pts_overall: totals?.pts_overall || 0, hidden: true };

    return {
      user,
      totals: publicTotals,
      heroStats: canSeeHeroes ? heroStats : null,
      recent: canSeeRecent ? recent : null,
      h2h,
      isOwner,
      privacy: {
        show_breakdown: !!user.show_breakdown,
        show_heroes: !!user.show_heroes,
        show_recent: !!user.show_recent,
      },
    };
  });
}
