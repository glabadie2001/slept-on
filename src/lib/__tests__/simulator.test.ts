import { describe, expect, it } from "vitest";
import {
  empiricalSd,
  makeNormal,
  mulberry32,
  simulateSeason,
  syntheticSchedule,
  teamStrengths,
} from "../simulator";
import type { SimGame, SimKnobs, SimTeamInput } from "../simulator";

const baseKnobs: SimKnobs = {
  sims: 2000,
  seed: 42,
  blend: 0.5,
  recencyHalfLife: null,
  volatility: 25,
  playoffTeams: 4,
  medianWins: false,
  forced: {},
  boosts: {},
};

function team(rosterId: number, ppg: number, wins = 0, losses = 0): SimTeamInput {
  return {
    rosterId,
    wins,
    losses,
    ties: 0,
    fpts: wins * ppg * 1.0,
    weeklyScores: [],
    projPpg: ppg,
  };
}

/** 8 teams, full round robin over 7 weeks */
function roundRobin(teams: SimTeamInput[]): SimGame[] {
  return syntheticSchedule(
    teams.map((t) => t.rosterId),
    [1, 2, 3, 4, 5, 6, 7],
    1,
  );
}

describe("rng", () => {
  it("is deterministic for a given seed", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });

  it("normal sampler has roughly the right mean and sd", () => {
    const normal = makeNormal(mulberry32(1));
    const n = 20000;
    let sum = 0;
    let ss = 0;
    for (let i = 0; i < n; i++) {
      const v = normal(100, 15);
      sum += v;
      ss += v * v;
    }
    const mean = sum / n;
    const sd = Math.sqrt(ss / n - mean * mean);
    expect(mean).toBeGreaterThan(99);
    expect(mean).toBeLessThan(101);
    expect(sd).toBeGreaterThan(14);
    expect(sd).toBeLessThan(16);
  });
});

describe("syntheticSchedule", () => {
  it("gives every team exactly one game per week", () => {
    const games = syntheticSchedule([1, 2, 3, 4, 5, 6], [1, 2, 3], 9);
    for (const week of [1, 2, 3]) {
      const wk = games.filter((g) => g.week === week);
      expect(wk).toHaveLength(3);
      const ids = wk.flatMap((g) => [g.a, g.b]).sort((a, b) => a - b);
      expect(ids).toEqual([1, 2, 3, 4, 5, 6]);
    }
  });

  it("never repeats a pairing within a full round robin", () => {
    const games = syntheticSchedule([1, 2, 3, 4, 5, 6, 7, 8], [1, 2, 3, 4, 5, 6, 7], 3);
    const seen = new Set(games.map((g) => [Math.min(g.a, g.b), Math.max(g.a, g.b)].join("-")));
    expect(seen.size).toBe(28); // C(8,2)
  });
});

describe("teamStrengths", () => {
  it("blends observed results with projections", () => {
    const t: SimTeamInput = { ...team(1, 120), weeklyScores: [80, 80, 80] };
    const [pure0] = teamStrengths([t], { ...baseKnobs, blend: 0 });
    const [pure1] = teamStrengths([t], { ...baseKnobs, blend: 1 });
    const [half] = teamStrengths([t], { ...baseKnobs, blend: 0.5 });
    expect(pure0.mean).toBeCloseTo(80);
    expect(pure1.mean).toBeCloseTo(120);
    expect(half.mean).toBeCloseTo(100);
  });

  it("recency half-life pulls the mean toward recent scores", () => {
    const t: SimTeamInput = { ...team(1, 100), weeklyScores: [60, 60, 60, 140, 140] };
    const [flat] = teamStrengths([t], { ...baseKnobs, blend: 0 });
    const [hot] = teamStrengths([t], { ...baseKnobs, blend: 0, recencyHalfLife: 1 });
    expect(hot.mean).toBeGreaterThan(flat.mean);
  });

  it("applies boosts", () => {
    const [s] = teamStrengths([team(1, 100)], { ...baseKnobs, blend: 1, boosts: { 1: 8 } });
    expect(s.mean).toBeCloseTo(108);
  });

  it("empiricalSd needs enough samples and clamps to a sane range", () => {
    expect(empiricalSd([{ ...team(1, 100), weeklyScores: [100, 110] }])).toBeNull();
    const teams = Array.from({ length: 6 }, (_, i) => ({
      ...team(i + 1, 100),
      weeklyScores: [90, 110, 95, 105],
    }));
    const sd = empiricalSd(teams);
    expect(sd).not.toBeNull();
    expect(sd!).toBeGreaterThanOrEqual(10);
    expect(sd!).toBeLessThanOrEqual(45);
  });
});

describe("simulateSeason", () => {
  const teams = [
    team(1, 140), // clearly best
    team(2, 120),
    team(3, 115),
    team(4, 110),
    team(5, 105),
    team(6, 100),
    team(7, 95),
    team(8, 75), // clearly worst
  ];

  it("is deterministic for identical inputs", () => {
    const games = roundRobin(teams);
    const a = simulateSeason(teams, games, baseKnobs, 1);
    const b = simulateSeason(teams, games, baseKnobs, 1);
    expect(a).toEqual(b);
  });

  it("stronger teams get better odds; probabilities are coherent", () => {
    const games = roundRobin(teams);
    const r = simulateSeason(teams, games, { ...baseKnobs, blend: 1 }, 1);
    const best = r.teams.find((t) => t.rosterId === 1)!;
    const worst = r.teams.find((t) => t.rosterId === 8)!;
    expect(best.playoffPct).toBeGreaterThan(80);
    expect(worst.playoffPct).toBeLessThan(20);
    expect(best.titlePct).toBeGreaterThan(worst.titlePct);
    // playoff odds sum to spots × 100, title odds to ~100
    const totalPlayoff = r.teams.reduce((s, t) => s + t.playoffPct, 0);
    expect(totalPlayoff).toBeGreaterThan(395);
    expect(totalPlayoff).toBeLessThan(405);
    const totalTitle = r.teams.reduce((s, t) => s + t.titlePct, 0);
    expect(totalTitle).toBeGreaterThan(99);
    expect(totalTitle).toBeLessThan(101);
    // seed distribution rows are probability distributions
    for (const t of r.teams) {
      const sum = t.seedDist.reduce((s, p) => s + p, 0);
      expect(sum).toBeCloseTo(1, 5);
    }
  });

  it("banked wins matter: same strength, better record → better odds", () => {
    const even = Array.from({ length: 8 }, (_, i) => team(i + 1, 100));
    even[0] = { ...even[0], wins: 5, losses: 0, fpts: 600 };
    even[7] = { ...even[7], wins: 0, losses: 5, fpts: 400 };
    const games = roundRobin(even);
    const r = simulateSeason(even, games, baseKnobs, null);
    const leader = r.teams.find((t) => t.rosterId === 1)!;
    const trailer = r.teams.find((t) => t.rosterId === 8)!;
    expect(leader.playoffPct).toBeGreaterThan(trailer.playoffPct + 30);
  });

  it("forcing a loss lowers playoff odds; forcing wins raises them", () => {
    const games = roundRobin(teams);
    const base = simulateSeason(teams, games, baseKnobs, 5);
    const myWeeks = games.filter((g) => g.a === 5 || g.b === 5).map((g) => g.week);
    const allLosses = Object.fromEntries(myWeeks.map((w) => [`${w}:5`, "L" as const]));
    const allWins = Object.fromEntries(myWeeks.map((w) => [`${w}:5`, "W" as const]));
    const lost = simulateSeason(teams, games, { ...baseKnobs, forced: allLosses }, 5);
    const won = simulateSeason(teams, games, { ...baseKnobs, forced: allWins }, 5);
    const pct = (r: typeof base) => r.teams.find((t) => t.rosterId === 5)!.playoffPct;
    expect(pct(lost)).toBeLessThan(1);
    expect(pct(won)).toBeGreaterThan(pct(base));
    expect(pct(won)).toBeGreaterThan(99);
  });

  it("leverage: odds-if-win exceed odds-if-lose for a bubble team", () => {
    const games = roundRobin(teams);
    const r = simulateSeason(teams, games, baseKnobs, 5);
    expect(r.leverage.length).toBe(7);
    for (const g of r.leverage) {
      expect(g.oddsIfWin).toBeGreaterThanOrEqual(g.oddsIfLose);
    }
  });

  it("boosting a team raises its odds", () => {
    const games = roundRobin(teams);
    const base = simulateSeason(teams, games, baseKnobs, null);
    const boosted = simulateSeason(teams, games, { ...baseKnobs, boosts: { 7: 25 } }, null);
    const pct = (r: typeof base, id: number) => r.teams.find((t) => t.rosterId === id)!.playoffPct;
    expect(pct(boosted, 7)).toBeGreaterThan(pct(base, 7) + 10);
  });

  it("median wins inflate win totals without breaking standings", () => {
    const games = roundRobin(teams);
    const base = simulateSeason(teams, games, baseKnobs, null);
    const median = simulateSeason(teams, games, { ...baseKnobs, medianWins: true }, null);
    const avg = (r: typeof base) => r.teams.reduce((s, t) => s + t.avgWins, 0) / r.teams.length;
    // each team plays 7 games; median adds ~0.5 wins/week on average
    expect(avg(median)).toBeGreaterThan(avg(base) + 2.5);
  });

  it("six-team playoff gives byes to the top two", () => {
    const games = roundRobin(teams);
    const r = simulateSeason(teams, games, { ...baseKnobs, playoffTeams: 6, blend: 1 }, null);
    expect(r.byes).toBe(2);
    const best = r.teams.find((t) => t.rosterId === 1)!;
    expect(best.byePct).toBeGreaterThan(50);
    const totalByes = r.teams.reduce((s, t) => s + t.byePct, 0);
    expect(totalByes).toBeGreaterThan(195);
    expect(totalByes).toBeLessThan(205);
  });
});
