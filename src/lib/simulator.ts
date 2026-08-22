import type { LeagueBundle, SleeperMatchup } from "../types";

/**
 * Monte Carlo season simulator.
 *
 * Each team's weekly score is modeled as Normal(mean, σ). The mean blends
 * observed results (recency-weighted PPG from actual weekly scores) with the
 * team's optimal-lineup projection; σ defaults to the pooled week-to-week
 * volatility observed league-wide. Every knob is explicit in `SimKnobs` so the
 * UI can expose it and tests can pin it.
 *
 * Deterministic: same inputs + seed → same output (seeded mulberry32 PRNG).
 */

// ---------- RNG ----------

export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller normal sampler over a uniform PRNG. */
export function makeNormal(rand: () => number): (mean: number, sd: number) => number {
  let spare: number | null = null;
  return (mean, sd) => {
    if (spare != null) {
      const v = spare;
      spare = null;
      return mean + sd * v;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    const mag = Math.sqrt(-2 * Math.log(u));
    spare = mag * Math.sin(2 * Math.PI * v);
    return mean + sd * mag * Math.cos(2 * Math.PI * v);
  };
}

// ---------- Inputs ----------

export interface SimTeamInput {
  rosterId: number;
  wins: number;
  losses: number;
  ties: number;
  fpts: number;
  /** actual scores from completed weeks, chronological order */
  weeklyScores: number[];
  /** optimal-lineup weekly projection */
  projPpg: number;
}

export interface SimGame {
  week: number;
  a: number; // roster_id
  b: number;
}

export interface SimKnobs {
  sims: number;
  seed: number;
  /** 0 = pure observed results, 1 = pure lineup projections */
  blend: number;
  /** weeks for recency half-life weighting of observed scores; null = flat */
  recencyHalfLife: number | null;
  /** weekly score σ in points; null = derive from observed scores */
  volatility: number | null;
  playoffTeams: number;
  /** each week, score above league median = extra win (median leagues) */
  medianWins: boolean;
  /** forced outcomes, keyed `${week}:${rosterId}` */
  forced: Record<string, "W" | "L">;
  /** what-if PPG deltas per roster (trade/injury scenarios) */
  boosts: Record<number, number>;
}

export const DEFAULT_SIMS = 5000;

// ---------- Team strength ----------

export interface TeamStrength {
  rosterId: number;
  mean: number;
  sd: number;
  resultsPpg: number;
  projPpg: number;
  boost: number;
}

function recencyWeightedMean(scores: number[], halfLife: number | null): number {
  if (scores.length === 0) return 0;
  let sum = 0;
  let wsum = 0;
  const n = scores.length;
  for (let i = 0; i < n; i++) {
    const w = halfLife == null ? 1 : Math.pow(0.5, (n - 1 - i) / halfLife);
    sum += scores[i] * w;
    wsum += w;
  }
  return sum / wsum;
}

/** Pooled week-to-week σ across all teams (individual teams have too few samples). */
export function empiricalSd(teams: SimTeamInput[]): number | null {
  let ss = 0;
  let n = 0;
  for (const t of teams) {
    if (t.weeklyScores.length < 2) continue;
    const mean = t.weeklyScores.reduce((s, v) => s + v, 0) / t.weeklyScores.length;
    for (const v of t.weeklyScores) {
      ss += (v - mean) ** 2;
      n++;
    }
  }
  if (n < 8) return null; // not enough data to trust
  return Math.min(45, Math.max(10, Math.sqrt(ss / n)));
}

export function teamStrengths(teams: SimTeamInput[], knobs: SimKnobs): TeamStrength[] {
  const sd =
    knobs.volatility ??
    empiricalSd(teams) ??
    Math.max(15, 0.28 * (teams.reduce((s, t) => s + t.projPpg, 0) / Math.max(1, teams.length)));

  return teams.map((t) => {
    const results = recencyWeightedMean(t.weeklyScores, knobs.recencyHalfLife);
    // With no observed scores (preseason), results side falls back to projection.
    const resultsPpg = t.weeklyScores.length > 0 ? results : t.projPpg;
    const boost = knobs.boosts[t.rosterId] ?? 0;
    const mean = (1 - knobs.blend) * resultsPpg + knobs.blend * t.projPpg + boost;
    return {
      rosterId: t.rosterId,
      mean,
      sd,
      resultsPpg: Math.round(resultsPpg * 10) / 10,
      projPpg: Math.round(t.projPpg * 10) / 10,
      boost,
    };
  });
}

// ---------- Simulation ----------

export interface TeamOdds {
  rosterId: number;
  playoffPct: number;
  byePct: number;
  titlePct: number;
  avgWins: number;
  avgSeed: number;
  /** P(final regular-season standing = index+1), 0..1 */
  seedDist: number[];
}

export interface LeverageRow {
  week: number;
  opponent: number;
  winPct: number;
  oddsIfWin: number;
  oddsIfLose: number;
  forced: "W" | "L" | null;
}

export interface SimSummary {
  teams: TeamOdds[];
  /** my remaining games with playoff odds conditioned on each outcome */
  leverage: LeverageRow[];
  strengths: TeamStrength[];
  sd: number;
  sims: number;
  byes: number;
}

function bracketByes(playoffTeams: number): number {
  if (playoffTeams < 2) return 0;
  let pow = 1;
  while (pow < playoffTeams) pow *= 2;
  return pow - playoffTeams;
}

/** Single-elimination bracket with reseeding; returns index (into seeds) of champion. */
function runBracket(
  seedRosterIds: number[],
  meanOf: Map<number, number>,
  sd: number,
  normal: (mean: number, sd: number) => number,
): number {
  let alive = seedRosterIds.map((rosterId, seed) => ({ rosterId, seed }));
  while (alive.length > 1) {
    const byes = bracketByes(alive.length);
    const next = alive.slice(0, byes);
    const field = alive.slice(byes);
    for (let i = 0; i < field.length / 2; i++) {
      const hi = field[i];
      const lo = field[field.length - 1 - i];
      const hiPts = normal(meanOf.get(hi.rosterId) ?? 0, sd);
      const loPts = normal(meanOf.get(lo.rosterId) ?? 0, sd);
      next.push(hiPts >= loPts ? hi : lo);
    }
    next.sort((x, y) => x.seed - y.seed);
    alive = next;
  }
  return alive[0].rosterId;
}

export function simulateSeason(
  teamInputs: SimTeamInput[],
  schedule: SimGame[],
  knobs: SimKnobs,
  myRosterId: number | null,
): SimSummary {
  const strengths = teamStrengths(teamInputs, knobs);
  const sd = strengths[0]?.sd ?? 25;
  const meanOf = new Map(strengths.map((s) => [s.rosterId, s.mean]));
  const n = teamInputs.length;
  const idxOf = new Map(teamInputs.map((t, i) => [t.rosterId, i]));
  const playoffTeams = Math.max(2, Math.min(n, knobs.playoffTeams));
  const byes = bracketByes(playoffTeams);

  const weeks = [...new Set(schedule.map((g) => g.week))].sort((x, y) => x - y);
  const gamesByWeek = new Map<number, SimGame[]>();
  for (const g of schedule) {
    const arr = gamesByWeek.get(g.week) ?? [];
    arr.push(g);
    gamesByWeek.set(g.week, arr);
  }
  const myGames = myRosterId == null ? [] : schedule.filter((g) => g.a === myRosterId || g.b === myRosterId);

  const rand = mulberry32(knobs.seed);
  const normal = makeNormal(rand);

  // Accumulators
  const playoffCount = new Array<number>(n).fill(0);
  const byeCount = new Array<number>(n).fill(0);
  const titleCount = new Array<number>(n).fill(0);
  const winSum = new Array<number>(n).fill(0);
  const seedSum = new Array<number>(n).fill(0);
  const seedDist = teamInputs.map(() => new Array<number>(n).fill(0));
  // leverage: per my remaining week → [wonCount, wonAndPlayoff, lostCount, lostAndPlayoff]
  const lev = new Map<number, [number, number, number, number]>();
  for (const g of myGames) lev.set(g.week, [0, 0, 0, 0]);

  const wins = new Array<number>(n);
  const fpts = new Array<number>(n);
  const weekScores = new Array<number>(n);
  const order = new Array<number>(n);

  for (let s = 0; s < knobs.sims; s++) {
    for (let i = 0; i < n; i++) {
      const t = teamInputs[i];
      wins[i] = t.wins + t.ties * 0.5;
      fpts[i] = t.fpts;
    }
    const myWeekWon = new Map<number, boolean>();

    for (const week of weeks) {
      const games = gamesByWeek.get(week)!;
      for (let i = 0; i < n; i++) weekScores[i] = NaN;
      for (const g of games) {
        const ia = idxOf.get(g.a);
        const ib = idxOf.get(g.b);
        if (ia == null || ib == null) continue;
        let sa = Math.max(0, normal(meanOf.get(g.a)!, sd));
        let sb = Math.max(0, normal(meanOf.get(g.b)!, sd));
        // Forced outcomes: swap scores if the sample disagrees (keeps fpts sane).
        const fa = knobs.forced[`${week}:${g.a}`];
        const fb = knobs.forced[`${week}:${g.b}`];
        const aMustWin = fa === "W" || fb === "L";
        const aMustLose = fa === "L" || fb === "W";
        if (aMustWin && sa <= sb) [sa, sb] = [sb, sa];
        else if (aMustLose && sa >= sb) [sa, sb] = [sb, sa];
        fpts[ia] += sa;
        fpts[ib] += sb;
        if (sa > sb) wins[ia] += 1;
        else if (sb > sa) wins[ib] += 1;
        else {
          wins[ia] += 0.5;
          wins[ib] += 0.5;
        }
        weekScores[ia] = sa;
        weekScores[ib] = sb;
        if (myRosterId != null && (g.a === myRosterId || g.b === myRosterId)) {
          myWeekWon.set(week, g.a === myRosterId ? sa > sb : sb > sa);
        }
      }
      if (knobs.medianWins) {
        const played = weekScores.filter((v) => !Number.isNaN(v)).sort((x, y) => x - y);
        if (played.length >= 2) {
          const mid = played.length / 2;
          const median =
            played.length % 2 === 1 ? played[Math.floor(mid)] : (played[mid - 1] + played[mid]) / 2;
          for (let i = 0; i < n; i++) {
            if (!Number.isNaN(weekScores[i]) && weekScores[i] > median) wins[i] += 1;
          }
        }
      }
    }

    // Final regular-season standings: wins desc, points-for desc.
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((x, y) => wins[y] - wins[x] || fpts[y] - fpts[x]);

    let myMadePlayoffs = false;
    for (let pos = 0; pos < n; pos++) {
      const i = order[pos];
      seedDist[i][pos]++;
      seedSum[i] += pos + 1;
      winSum[i] += wins[i];
      if (pos < playoffTeams) {
        playoffCount[i]++;
        if (pos < byes) byeCount[i]++;
        if (teamInputs[i].rosterId === myRosterId) myMadePlayoffs = true;
      }
    }

    const champ = runBracket(
      order.slice(0, playoffTeams).map((i) => teamInputs[i].rosterId),
      meanOf,
      sd,
      normal,
    );
    titleCount[idxOf.get(champ)!]++;

    for (const [week, won] of myWeekWon) {
      const acc = lev.get(week);
      if (!acc) continue;
      if (won) {
        acc[0]++;
        if (myMadePlayoffs) acc[1]++;
      } else {
        acc[2]++;
        if (myMadePlayoffs) acc[3]++;
      }
    }
  }

  const pct = (c: number) => Math.round((c / knobs.sims) * 1000) / 10;
  const teams: TeamOdds[] = teamInputs.map((t, i) => ({
    rosterId: t.rosterId,
    playoffPct: pct(playoffCount[i]),
    byePct: pct(byeCount[i]),
    titlePct: pct(titleCount[i]),
    avgWins: Math.round((winSum[i] / knobs.sims) * 10) / 10,
    avgSeed: Math.round((seedSum[i] / knobs.sims) * 10) / 10,
    seedDist: seedDist[i].map((c) => c / knobs.sims),
  }));

  const leverage: LeverageRow[] = myGames
    .map((g) => {
      const [wonN, wonP, lostN, lostP] = lev.get(g.week)!;
      const opponent = g.a === myRosterId ? g.b : g.a;
      return {
        week: g.week,
        opponent,
        winPct: pct(wonN),
        oddsIfWin: wonN > 0 ? Math.round((wonP / wonN) * 1000) / 10 : 0,
        oddsIfLose: lostN > 0 ? Math.round((lostP / lostN) * 1000) / 10 : 0,
        forced: knobs.forced[`${g.week}:${myRosterId}`] ?? null,
      };
    })
    .sort((x, y) => x.week - y.week);

  return { teams, leverage, strengths, sd: Math.round(sd * 10) / 10, sims: knobs.sims, byes };
}

// ---------- Bundle → sim inputs ----------

export interface SeasonSchedule {
  /** remaining games to simulate (current week onward) */
  games: SimGame[];
  /** actual scores per roster from completed weeks, chronological */
  weeklyScores: Record<number, number[]>;
  completedWeeks: number[];
  regularSeasonEnd: number;
  /** true when Sleeper had no schedule and a synthetic round-robin was generated */
  synthetic: boolean;
}

function pairs(matchups: SleeperMatchup[]): [SleeperMatchup, SleeperMatchup][] {
  const byId = new Map<number, SleeperMatchup[]>();
  for (const m of matchups) {
    if (m.matchup_id == null) continue;
    const arr = byId.get(m.matchup_id) ?? [];
    arr.push(m);
    byId.set(m.matchup_id, arr);
  }
  return [...byId.values()].filter((v): v is [SleeperMatchup, SleeperMatchup] => v.length === 2);
}

/** Round-robin (circle method) schedule when Sleeper doesn't have one yet. */
export function syntheticSchedule(rosterIds: number[], weeks: number[], seed: number): SimGame[] {
  const rand = mulberry32(seed);
  const ids = [...rosterIds];
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  if (ids.length % 2 === 1) ids.push(-1); // ghost bye slot
  const n = ids.length;
  const games: SimGame[] = [];
  const rot = ids.slice(1);
  for (let w = 0; w < weeks.length; w++) {
    const round = [ids[0], ...rot];
    for (let i = 0; i < n / 2; i++) {
      const a = round[i];
      const b = round[n - 1 - i];
      if (a !== -1 && b !== -1) games.push({ week: weeks[w], a, b });
    }
    rot.unshift(rot.pop()!); // rotate
  }
  return games;
}

export function buildSeasonSchedule(bundle: LeagueBundle): SeasonSchedule {
  const regularSeasonEnd = (bundle.league.settings.playoff_week_start ?? 15) - 1;
  const currentWeek = bundle.week;
  const weeklyScores: Record<number, number[]> = {};
  for (const r of bundle.rosters) weeklyScores[r.roster_id] = [];
  const games: SimGame[] = [];
  const completedWeeks: number[] = [];

  for (let week = 1; week <= regularSeasonEnd; week++) {
    const matchups = bundle.schedule[week];
    if (!matchups || matchups.length === 0) continue;
    const wPairs = pairs(matchups);
    const played = week < currentWeek && matchups.some((m) => (m.points ?? 0) > 0);
    if (played) {
      completedWeeks.push(week);
      for (const [a, b] of wPairs) {
        weeklyScores[a.roster_id]?.push(a.points ?? 0);
        weeklyScores[b.roster_id]?.push(b.points ?? 0);
      }
    } else if (week >= currentWeek) {
      for (const [a, b] of wPairs) games.push({ week, a: a.roster_id, b: b.roster_id });
    }
  }

  if (games.length === 0 && completedWeeks.length < regularSeasonEnd) {
    // No schedule from Sleeper (offseason / pre-draft): simulate a hypothetical one.
    const weeks = [];
    for (let w = Math.max(1, currentWeek); w <= regularSeasonEnd; w++) weeks.push(w);
    if (weeks.length > 0) {
      return {
        games: syntheticSchedule(bundle.rosters.map((r) => r.roster_id), weeks, 7),
        weeklyScores,
        completedWeeks,
        regularSeasonEnd,
        synthetic: true,
      };
    }
  }

  return { games, weeklyScores, completedWeeks, regularSeasonEnd, synthetic: false };
}
