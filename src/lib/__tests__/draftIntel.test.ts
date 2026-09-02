import { describe, expect, it } from "vitest";
import {
  marketDivergence,
  needMultipliers,
  pickOwner,
  pickPosition,
  qbMarketContext,
  survivalOdds,
  upcomingPicks,
} from "../draftIntel";
import type { ConsensusRow } from "../guides";
import type { BlendedValue } from "../market";
import type {
  PlayerMap,
  SleeperDraft,
  SleeperLeague,
  SleeperRoster,
  SleeperTradedPick,
} from "../../types";

const draft = (over: Partial<SleeperDraft> = {}): SleeperDraft =>
  ({
    draft_id: "d",
    status: "drafting",
    type: "linear",
    season: "2026",
    start_time: null,
    settings: { rounds: 3, teams: 3 },
    draft_order: null,
    slot_to_roster_id: { "1": 10, "2": 20, "3": 30 },
    ...over,
  }) as SleeperDraft;

const traded = (round: number, roster_id: number, owner_id: number): SleeperTradedPick => ({
  season: "2026",
  round,
  roster_id,
  previous_owner_id: roster_id,
  owner_id,
});

describe("pickPosition", () => {
  it("maps overall picks for linear drafts", () => {
    expect(pickPosition(4, 3, "linear")).toEqual({ round: 2, slot: 1 });
    expect(pickPosition(6, 3, "linear")).toEqual({ round: 2, slot: 3 });
  });

  it("reverses even rounds for snake drafts", () => {
    expect(pickPosition(4, 3, "snake")).toEqual({ round: 2, slot: 3 });
    expect(pickPosition(6, 3, "snake")).toEqual({ round: 2, slot: 1 });
    expect(pickPosition(7, 3, "snake")).toEqual({ round: 3, slot: 1 });
  });
});

describe("pickOwner / upcomingPicks", () => {
  it("honors traded picks when resolving the roster on the clock", () => {
    const d = draft();
    expect(pickOwner(4, d, [])).toBe(10); // R2.1 natural
    expect(pickOwner(4, d, [traded(2, 10, 30)])).toBe(30); // R2.1 dealt away
    expect(pickOwner(1, d, [traded(2, 10, 30)])).toBe(10); // R1.1 untouched
  });

  it("finds my next pick and everyone drafting before it", () => {
    // Roster 10 (slot 1) also acquired R2.3 (roster 30's pick).
    const picks = [traded(2, 30, 10)];
    const after1 = upcomingPicks(draft(), picks, 1, 10);
    expect(after1.myNextPick).toBe(4); // my natural R2.1
    expect(after1.interveningRosters).toEqual([20, 30]); // picks 2, 3

    const after4 = upcomingPicks(draft(), picks, 4, 10);
    expect(after4.myNextPick).toBe(6); // acquired R2.3
    expect(after4.interveningRosters).toEqual([20]);
  });

  it("returns null when I have no picks left", () => {
    const out = upcomingPicks(draft(), [], 7, 10); // only R3.2/R3.3 remain
    expect(upcomingPicks(draft(), [], 6, 10).myNextPick).toBe(7);
    expect(out.myNextPick).toBeNull();
    expect(out.interveningRosters).toEqual([]);
  });
});

// ---------- board fixtures ----------

const row = (
  key: string,
  consensus: number,
  position: string | null,
  sleeperId: string | null = null,
): ConsensusRow => ({
  key,
  displayName: key,
  sleeperId,
  position,
  ranks: {},
  avg: consensus,
  best: consensus,
  worst: consensus,
  sd: 0,
  tier: null,
  count: 1,
  nEff: 1,
  consensus,
});

const val = (playerId: string, value: number, market: number | null): BlendedValue => ({
  playerId,
  value,
  winNow: value,
  ppg: 0,
  ageMult: 1,
  market,
  marketNorm: market,
});

describe("marketDivergence", () => {
  it("ranks by market and reports consensus minus market rank", () => {
    const board = [row("a", 1, "WR", "1"), row("b", 2, "RB", "2"), row("c", 3, "WR", "3")];
    const values = { "1": val("1", 50, 1000), "2": val("2", 40, 500), "3": val("3", 60, 4000) };
    const div = marketDivergence(board, values);
    expect(div.get("c")).toEqual({ marketRank: 1, divergence: 2 }); // market loves him
    expect(div.get("a")).toEqual({ marketRank: 2, divergence: -1 });
    expect(div.get("b")).toEqual({ marketRank: 3, divergence: -1 });
  });

  it("skips unmatched and unpriced rows", () => {
    const board = [row("a", 1, "WR", "1"), row("ghost", 2, "WR", null)];
    const div = marketDivergence(board, { "1": val("1", 50, null) });
    expect(div.size).toBe(0);
  });
});

// ---------- league fixtures ----------

const league = (positions: string[]): SleeperLeague =>
  ({
    league_id: "l",
    season: "2026",
    total_rosters: 2,
    roster_positions: positions,
    scoring_settings: { rec: 1 },
  }) as unknown as SleeperLeague;

const ONE_QB = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "BN"];

const roster = (roster_id: number, players: string[]): SleeperRoster =>
  ({ roster_id, players }) as unknown as SleeperRoster;

const players: PlayerMap = {
  q1: { player_id: "q1", full_name: "Young Star QB", position: "QB", age: 25 },
  q2: { player_id: "q2", full_name: "Old Bridge QB", position: "QB", age: 34 },
  r1: { player_id: "r1", full_name: "Stud RB", position: "RB", age: 23 },
  w1: { player_id: "w1", full_name: "Stud WR", position: "WR", age: 24 },
};

describe("qbMarketContext", () => {
  const values = {
    q1: val("q1", 80, null),
    q2: val("q2", 40, null),
    r1: val("r1", 90, null),
    w1: val("w1", 90, null),
  };

  it("declares the QB market dead when every 1QB team is set", () => {
    const ctx = qbMarketContext(
      league(ONE_QB),
      [roster(1, ["q1", "r1"]), roster(2, ["q1", "w1"])],
      players,
      values,
    );
    expect(ctx.dead).toBe(true);
    expect(ctx.setTeams).toBe(2);
  });

  it("keeps the market alive while any team lacks a long-term starter", () => {
    const ctx = qbMarketContext(
      league(ONE_QB),
      [roster(1, ["q1", "r1"]), roster(2, ["q2", "w1"])], // old low-value QB ≠ set
      players,
      values,
    );
    expect(ctx.dead).toBe(false);
    expect(ctx.setTeams).toBe(1);
  });

  it("never declares superflex QB markets dead", () => {
    const ctx = qbMarketContext(
      league([...ONE_QB, "SUPER_FLEX"]),
      [roster(1, ["q1"]), roster(2, ["q1"])],
      players,
      values,
    );
    expect(ctx.dead).toBe(false);
  });
});

describe("needMultipliers", () => {
  const values = {
    q1: val("q1", 80, null),
    r1: val("r1", 90, null),
    w1: val("w1", 90, null),
  };

  it("marks the RB-poor roster hungrier than the RB-rich one", () => {
    const lg = league(ONE_QB);
    const rosters = [roster(1, ["q1", "r1", "w1"]), roster(2, ["q1", "w1"])];
    const qb = qbMarketContext(lg, rosters, players, values);
    const needs = needMultipliers(lg, rosters, players, values, qb);
    const rich = needs.get(1)!;
    const poor = needs.get(2)!;
    expect(poor.RB).toBeGreaterThan(rich.RB);
    expect(poor.RB).toBeGreaterThan(1);
  });

  it("floors QB appetite when the QB market is dead", () => {
    const lg = league(ONE_QB);
    const rosters = [roster(1, ["q1", "r1"]), roster(2, ["q1", "w1"])];
    const qb = qbMarketContext(lg, rosters, players, values);
    expect(qb.dead).toBe(true);
    const needs = needMultipliers(lg, rosters, players, values, qb);
    expect(needs.get(1)!.QB).toBe(0.25);
  });
});

describe("survivalOdds", () => {
  const board = [
    row("top", 1, "RB"),
    row("second", 2, "WR"),
    row("mid", 6, "WR"),
    row("deep", 12, "TE"),
  ];

  it("returns 1 for everyone when nobody picks before me", () => {
    const odds = survivalOdds(board, [], new Map());
    expect(odds.get("top")).toBe(1);
  });

  it("decays down the board and compounds across picks", () => {
    const odds1 = survivalOdds(board, [1], new Map());
    const odds2 = survivalOdds(board, [1, 2], new Map());
    expect(odds1.get("top")!).toBeLessThan(odds1.get("mid")!);
    expect(odds2.get("top")!).toBeLessThan(odds1.get("top")!);
    for (const p of odds2.values()) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it("a hungry team makes its need position less likely to survive", () => {
    const neutral = survivalOdds(board, [1], new Map([[1, { RB: 1, WR: 1 }]]));
    const rbHungry = survivalOdds(board, [1], new Map([[1, { RB: 1.8, WR: 0.6 }]]));
    expect(rbHungry.get("top")!).toBeLessThan(neutral.get("top")!);
    expect(rbHungry.get("second")!).toBeGreaterThan(neutral.get("second")!);
  });
});
