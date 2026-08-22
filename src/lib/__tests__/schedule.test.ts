import { describe, expect, it } from "vitest";
import { buildDemoBundle } from "../../demo/demoData";
import { buildSeasonSchedule, simulateSeason } from "../simulator";
import type { SimKnobs } from "../simulator";

describe("demo bundle + buildSeasonSchedule integration", () => {
  const bundle = buildDemoBundle();
  const season = buildSeasonSchedule(bundle);

  it("demo records are consistent with the played weekly scores", () => {
    for (const r of bundle.rosters) {
      const scores = season.weeklyScores[r.roster_id];
      expect(scores).toHaveLength(5); // weeks 1-5 played
      expect(r.settings.wins + r.settings.losses).toBe(5);
      const fpts = scores.reduce((s, v) => s + v, 0);
      expect(r.settings.fpts).toBeCloseTo(fpts, 1);
    }
  });

  it("remaining schedule covers weeks 6-14 with every team playing weekly", () => {
    expect(season.synthetic).toBe(false);
    expect(season.completedWeeks).toEqual([1, 2, 3, 4, 5]);
    expect(season.regularSeasonEnd).toBe(14);
    for (let w = 6; w <= 14; w++) {
      const wk = season.games.filter((g) => g.week === w);
      expect(wk).toHaveLength(6);
      const ids = wk.flatMap((g) => [g.a, g.b]).sort((a, b) => a - b);
      expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    }
  });

  it("simulates the demo league end-to-end with sane output", () => {
    const knobs: SimKnobs = {
      sims: 1000,
      seed: 1337,
      blend: 0.35,
      recencyHalfLife: null,
      volatility: null,
      playoffTeams: 6,
      medianWins: false,
      forced: {},
      boosts: {},
    };
    const teams = bundle.rosters.map((r) => ({
      rosterId: r.roster_id,
      wins: r.settings.wins,
      losses: r.settings.losses,
      ties: r.settings.ties,
      fpts: r.settings.fpts,
      weeklyScores: season.weeklyScores[r.roster_id] ?? [],
      projPpg: 100 + r.roster_id, // stand-in projections
    }));
    const result = simulateSeason(teams, season.games, knobs, 1);
    expect(result.teams).toHaveLength(12);
    expect(result.leverage).toHaveLength(9); // weeks 6-14
    // The juggernaut (roster 7: strong scores + 7pt boost baked into demo data)
    // should comfortably out-odds my handicapped roster 1.
    const me = result.teams.find((t) => t.rosterId === 1)!;
    const them = result.teams.find((t) => t.rosterId === 7)!;
    expect(them.playoffPct).toBeGreaterThan(me.playoffPct);
    // σ derived from observed demo scores lands in the clamp range
    expect(result.sd).toBeGreaterThanOrEqual(10);
    expect(result.sd).toBeLessThanOrEqual(45);
  });

  it("preseason (empty schedule map) falls back to a synthetic schedule", () => {
    const pre = buildSeasonSchedule({ ...bundle, schedule: {}, week: 1 });
    expect(pre.synthetic).toBe(true);
    expect(pre.completedWeeks).toEqual([]);
    for (let w = 1; w <= 14; w++) {
      expect(pre.games.filter((g) => g.week === w)).toHaveLength(6);
    }
  });
});
