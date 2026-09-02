import { describe, expect, it } from "vitest";
import { runMocks, setupFromSleeperDraft, rankedChoices } from "../mockDraft";
import type { MockDraft, NeedModel } from "../mockDraft";
import {
  availabilityMatrix,
  percentiles,
  pickTimelines,
  positionRuns,
  scoreTimelines,
  targetsAt,
  typicalRoster,
  whatHadToGoRight,
} from "../mockAnalysis";
import { branchPoint, candidatesAt, compareCandidates, seasonFor, seasonOdds } from "../timelines";
import type { ConsensusRow } from "../guides";
import type { SleeperDraft, SleeperLeague } from "../../types";

const league = (positions: string[]): SleeperLeague =>
  ({
    league_id: "l",
    season: "2026",
    total_rosters: 4,
    roster_positions: positions,
    scoring_settings: { rec: 1 },
    settings: { type: 0 },
  }) as unknown as SleeperLeague;

const SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "BN", "BN"];

const draft = (rounds: number): SleeperDraft =>
  ({
    draft_id: "d",
    status: "pre_draft",
    type: "snake",
    season: "2026",
    start_time: null,
    settings: { rounds, teams: 4 },
    draft_order: null,
    slot_to_roster_id: { "1": 10, "2": 20, "3": 30, "4": 40 },
  }) as SleeperDraft;

const row = (i: number, position: string): ConsensusRow => ({
  key: `p${i}`,
  displayName: `Player ${i}`,
  sleeperId: `s${i}`,
  position,
  ranks: {},
  avg: i,
  best: i,
  worst: i,
  sd: 0,
  tier: null,
  count: 1,
  consensus: i,
});
const positions = ["RB", "WR", "QB", "WR", "RB", "TE"];
const board = Array.from({ length: 60 }, (_, i) => row(i + 1, positions[i % positions.length]));
const model: NeedModel = { mode: "redraft", league: league(SLOTS), base: new Map() };
const setup = setupFromSleeperDraft(draft(5), [], 20, 3)!;
const empty: MockDraft = { setup, picks: [] };
// score = sum of (61 - consensus) over the roster: higher picks are worth more
const scoreRoster = (ids: string[]) => ids.reduce((s, id) => s + (61 - parseInt(id.slice(1), 10)), 0);
const rosterIds = [10, 20, 30, 40];

describe("batch extensions", () => {
  const batch = runMocks(empty, board, model, 30);

  it("keeps every timeline and an ADP range", () => {
    expect(batch.timelines).toHaveLength(30);
    expect(batch.timelines[0].picks).toHaveLength(20);
    expect(batch.startedAt).toBe(0);
    const top = batch.adp.get("p1")!;
    expect(top.min).toBeGreaterThanOrEqual(1);
    expect(top.max).toBeGreaterThanOrEqual(top.min);
    expect(top.avg).toBeGreaterThanOrEqual(top.min);
  });

  it("forced picks land in my slot in every run and are marked as my own", () => {
    const forced = runMocks(empty, board, model, 10, { forced: { 2: "p9" } });
    for (const t of forced.timelines) {
      expect(t.picks[1]).toMatchObject({ key: "p9", rosterId: 20, mine: true, auto: false });
    }
  });

  it("sampled policy varies my picks where greedy does not", () => {
    const greedy = runMocks(empty, board, model, 20);
    const sampled = runMocks(empty, board, model, 20, { myPolicy: "sample" });
    const firstPicks = (b: typeof greedy) => new Set(b.timelines.map((t) => t.picks[1].key));
    expect(firstPicks(greedy).size).toBeLessThanOrEqual(firstPicks(sampled).size);
  });

  it("availability matrix has one column per remaining pick and monotone-ish odds", () => {
    const m = availabilityMatrix(batch, board, 10);
    expect(m.picks).toEqual([2, 7, 10, 15, 18]);
    expect(m.rows).toHaveLength(10);
    // consensus #1 is less available than #10 at my first pick
    expect(m.rows[0].pct[0]).toBeLessThanOrEqual(m.rows[9].pct[0]);
    for (const r of m.rows) for (const p of r.pct) expect(p).toBeGreaterThanOrEqual(0);
  });

  it("targets rank by value × availability, not consensus", () => {
    const t = targetsAt(batch, 7, board, (r) => 100 - r.consensus, 5, 0.2);
    expect(t.length).toBeGreaterThan(0);
    for (let i = 1; i < t.length; i++) expect(t[i - 1].score).toBeGreaterThanOrEqual(t[i].score);
    for (const x of t) expect(x.pct).toBeGreaterThanOrEqual(0.2);
  });

  it("positional runs report medians in ascending order", () => {
    const runs = positionRuns(batch, ["RB", "WR", "QB"], [1, 2, 4]);
    const rb = runs.find((r) => r.position === "RB")!;
    expect(rb.median[0]).not.toBeNull();
    expect(rb.median[0]!).toBeLessThanOrEqual(rb.median[1]!);
    expect(rb.median[1]!).toBeLessThanOrEqual(rb.median[2]!);
  });

  it("typical roster lists my slots with frequencies summing to at most 1 and a position mix", () => {
    const tr = typicalRoster(batch, 20);
    expect(tr.slots.map((s) => s.pickNo)).toEqual([2, 7, 10, 15, 18]);
    for (const s of tr.slots) {
      const total = s.options.reduce((a, o) => a + o.pct, 0);
      expect(total).toBeLessThanOrEqual(1.0001);
      expect(s.options[0].pct).toBeGreaterThan(0);
    }
    expect(tr.mix.length).toBeGreaterThan(0);
    expect(tr.mix[0].label).toMatch(/RB|WR|QB/);
  });

  it("scores timelines, picks best/median/worst and finds lucky picks", () => {
    const scored = scoreTimelines(batch, rosterIds, 20, new Map(), scoreRoster);
    expect(scored).toHaveLength(30);
    for (const s of scored) {
      expect(s.myRank).toBeGreaterThanOrEqual(1);
      expect(s.myRank).toBeLessThanOrEqual(4);
      expect(s.scores.size).toBe(4);
    }
    const p = pickTimelines(scored)!;
    expect(p.best.myScore).toBeGreaterThanOrEqual(p.median.myScore);
    expect(p.median.myScore).toBeGreaterThanOrEqual(p.worst.myScore);
    const lucky = whatHadToGoRight(p.best.run, batch, 20, 0.99);
    for (const l of lucky) expect(l.pick.rosterId).toBe(20);
    expect(percentiles([1, 2, 3, 4, 5])).toMatchObject({ p10: 1, median: 3, p90: 5, mean: 3 });
  });
});

describe("timelines (decision conditioning)", () => {
  it("branches at my next pick and offers ranked candidates", () => {
    const at = branchPoint(empty, board, model)!;
    expect(at.picks).toHaveLength(1);
    const cands = candidatesAt(at, board, model, 3);
    expect(cands).toHaveLength(3);
    expect(new Set(cands.map((c) => c.key)).size).toBe(3);
    expect(rankedChoices(board, {}, 2).map((r) => r.key)).toEqual(["p1", "p2"]);
  });

  it("compares candidates with forced first picks and season odds", () => {
    const at = branchPoint(empty, board, model)!;
    const cands = candidatesAt(at, board, model, 2);
    const season = seasonFor(rosterIds, [], 6, 2, 200, 11);
    expect(season.games.length).toBeGreaterThan(0);
    const out = compareCandidates({
      base: at,
      board,
      model,
      candidates: cands,
      runsPerCandidate: 12,
      rosterIds,
      baseRosters: new Map(),
      scoreRoster,
      season,
    });
    expect(out).toHaveLength(2);
    for (const o of out) {
      expect(o.runs).toBe(12);
      expect(o.median.run.picks[1].key).toBe(o.row.key); // the forced pick
      expect(o.score.p10).toBeLessThanOrEqual(o.score.p90);
      expect(o.avgRank).toBeGreaterThanOrEqual(1);
      expect(o.odds!.playoffPct).toBeGreaterThanOrEqual(0);
      expect(o.odds!.playoffPct).toBeLessThanOrEqual(100);
    }
  });

  it("season odds favour the stronger roster", () => {
    const season = seasonFor(rosterIds, [], 8, 2, 400, 5);
    const scores = new Map([[10, 140], [20, 120], [30, 100], [40, 90]]);
    const strong = seasonOdds(scores, 10, season);
    const weak = seasonOdds(scores, 40, season);
    expect(strong.playoffPct).toBeGreaterThan(weak.playoffPct);
    expect(strong.titlePct).toBeGreaterThan(weak.titlePct);
  });
});
