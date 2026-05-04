// Scoring rules for Unmatched community app.
// All point computation lives here so it's auditable in one place.
//
// Game types: '1v1' | '2v2' | 'ffa3' | 'ffa4'

export const PLAYER_COUNT = { '1v1': 2, '2v2': 4, ffa3: 3, ffa4: 4 };

// Result shape passed by the room creator on finalize:
//   {
//     type: '1v1' | '2v2' | 'ffa3' | 'ffa4',
//     players: [
//       { tg_id, team?: 0|1, elimination_order: number|null }
//       // elimination_order: 1 = eliminated first, 2 = second, ... null = survived
//     ]
//   }
//
// Returns array of { tg_id, is_winner, points_awarded } in the same order.

export function computePoints({ type, players }) {
  if (type === '1v1') return score1v1(players);
  if (type === '2v2') return score2v2(players);
  if (type === 'ffa3' || type === 'ffa4') return scoreFFA(type, players);
  throw new Error(`Unknown game type: ${type}`);
}

function score1v1(players) {
  if (players.length !== 2) throw new Error('1v1 requires exactly 2 players');
  return players.map((p) => {
    const won = p.elimination_order == null;
    return { tg_id: p.tg_id, is_winner: won ? 1 : 0, points_awarded: won ? 3 : 0 };
  });
}

function score2v2(players) {
  if (players.length !== 4) throw new Error('2v2 requires exactly 4 players');
  const teams = { 0: [], 1: [] };
  for (const p of players) {
    if (p.team !== 0 && p.team !== 1) throw new Error('2v2 requires team 0 or 1 for every player');
    teams[p.team].push(p);
  }
  if (teams[0].length !== 2 || teams[1].length !== 2) {
    throw new Error('2v2 requires exactly 2 players per team');
  }

  const teamSurvived = (t) => t.some((p) => p.elimination_order == null);
  const winningTeam = teamSurvived(teams[0]) ? 0 : teamSurvived(teams[1]) ? 1 : null;
  if (winningTeam == null) throw new Error('2v2 must have a winning team (at least one survivor)');

  const out = [];
  for (const p of players) {
    const isWinner = p.team === winningTeam;
    let pts;
    if (isWinner) {
      pts = p.elimination_order == null ? 3 : 2;
    } else {
      // losing team: both must be eliminated; "last" = max elimination_order
      const losers = teams[1 - winningTeam];
      const lastElim = Math.max(...losers.map((x) => x.elimination_order ?? -Infinity));
      pts = p.elimination_order === lastElim ? 1 : 0;
    }
    out.push({ tg_id: p.tg_id, is_winner: isWinner ? 1 : 0, points_awarded: pts });
  }
  return out;
}

const FFA_POINTS = {
  ffa3: { 1: 3, 2: 2, 3: 0 },
  ffa4: { 1: 3, 2: 2, 3: 1, 4: 0 },
};

function scoreFFA(type, players) {
  const expected = type === 'ffa3' ? 3 : 4;
  if (players.length !== expected) throw new Error(`${type} requires ${expected} players`);

  // Place = expected - elimination_order + 1; survivor (null) = 1st.
  // Eliminated players' orders must be a permutation of [1..expected-1].
  const placed = players.map((p) => {
    const place = p.elimination_order == null ? 1 : expected - p.elimination_order + 1;
    return { ...p, place };
  });

  const places = placed.map((p) => p.place).sort((a, b) => a - b);
  const expectedPlaces = Array.from({ length: expected }, (_, i) => i + 1);
  if (JSON.stringify(places) !== JSON.stringify(expectedPlaces)) {
    throw new Error(`${type} requires a unique placement for each player`);
  }

  const table = FFA_POINTS[type];
  return placed.map((p) => ({
    tg_id: p.tg_id,
    is_winner: p.place === 1 ? 1 : 0,
    points_awarded: table[p.place],
  }));
}
