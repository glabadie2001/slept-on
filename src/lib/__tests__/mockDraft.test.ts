import { describe, expect, it } from "vitest";
import { CONSIDERATION_SET, draftedPositionsFromPicks, pickNeedMultipliers, positionTargets } from "../draftIntel";
import { detectDraftMode, draftableSlots, defaultRounds, modeValue } from "../draftMode";
import {
  advance,
  availableRows,
  cpuChoose,
  makePick,
  myPickNumbers,
  needsFor,
  runMocks,
  setupFromSleeperDraft,
  slotAt,
  summarize,
  syntheticSetup,
  undoToMyLastPick,
} from "../mockDraft";
import type { MockDraft, NeedModel } from "../mockDraft";
import type { ConsensusRow } from "../guides";
import type { SleeperDraft, SleeperLeague, SleeperRoster } from "../../types";

const league = (positions: string[], type = 2): SleeperLeague =>
  ({
    league_id: "l",
    season: "2026",
    total_rosters: 4,
    roster_positions: positions,
    scoring_settings: { rec: 1 },
    settings: { type },
  }) as unknown as SleeperLeague;

const REDRAFT_SLOTS = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "BN", "IR"];

const roster = (roster_id: number, players: string[] = []): SleeperRoster =>
  ({ roster_id, players }) as unknown as SleeperRoster;

const draft = (over: Partial<SleeperDraft> = {}): SleeperDraft =>
  ({
    draft_id: "d",
    status: "pre_draft",
    type: "snake",
    season: "2026",
    start_time: null,
    settings: { rounds: 15, teams: 4 },
    draft_order: null,
    slot_to_roster_id: { "1": 10, "2": 20, "3": 30, "4": 40 },
    ...over,
  }) as SleeperDraft;

describe("detectDraftMode", () => {
  it("redraft and keeper leagues are redraft regardless of draft shape", () => {
    expect(detectDraftMode(league(REDRAFT_SLOTS, 0), [roster(1, ["a"])], draft())).toBe("redraft");
    expect(detectDraftMode(league(REDRAFT_SLOTS, 1), [], null)).toBe("redraft");
  });

  it("dynasty with populated rosters and a short draft is a rookie draft", () => {
    const d = draft({ settings: { rounds: 4, teams: 4 } });
    expect(detectDraftMode(league(REDRAFT_SLOTS), [roster(1, ["a", "b"])], d)).toBe("rookie");
    expect(detectDraftMode(league(REDRAFT_SLOTS), [roster(1, ["a"])], null)).toBe("rookie");
  });

  it("dynasty with a roster-length draft or empty rosters is a startup", () => {
    expect(detectDraftMode(league(REDRAFT_SLOTS), [roster(1, ["a"])], draft())).toBe("startup");
    expect(detectDraftMode(league(REDRAFT_SLOTS), [roster(1), roster(2)], null)).toBe("startup");
  });

  it("default rounds fill the draftable roster outside rookie mode", () => {
    expect(draftableSlots(league(REDRAFT_SLOTS))).toBe(15);
    expect(defaultRounds("redraft", league(REDRAFT_SLOTS), null)).toBe(15);
    expect(defaultRounds("rookie", league(REDRAFT_SLOTS), null)).toBe(4);
    expect(defaultRounds("rookie", league(REDRAFT_SLOTS), draft({ settings: { rounds: 5, teams: 4 } }))).toBe(5);
  });

  it("modeValue swaps to win-now for redraft", () => {
    const v = { playerId: "x", value: 80, winNow: 20, ppg: 0, ageMult: 1, market: null, marketNorm: null };
    expect(modeValue("rookie", v)).toBe(80);
    expect(modeValue("redraft", v)).toBe(20);
    expect(modeValue("redraft", null)).toBeNull();
  });
});

describe("pickNeedMultipliers", () => {
  const lg = league(REDRAFT_SLOTS, 0);

  it("targets include flex shares and bench allowance", () => {
    const t = positionTargets(lg, 15);
    expect(t.strict.RB).toBe(2);
    expect(t.starters.RB).toBeCloseTo(2.45);
    expect(t.targets.RB).toBeGreaterThan(t.starters.RB);
    expect(t.startingSlots).toBe(9);
  });

  it("a team with no QB in round 6 is hungrier for one than a team that has one", () => {
    const drafted = new Map<number, string[]>([
      [1, ["RB", "WR", "RB", "WR", "TE"]],
      [2, ["QB", "RB", "WR", "RB", "WR"]],
    ]);
    const m = pickNeedMultipliers(lg, 15, 6, drafted, [1, 2]);
    expect(m.get(1)!.QB).toBeGreaterThan(1.4);
    expect(m.get(2)!.QB).toBeLessThan(0.3); // 1QB league, backup can wait
  });

  it("ignores K/DEF until the closing rounds, then demands them", () => {
    const drafted = new Map<number, string[]>([[1, Array(13).fill("WR")]]);
    expect(pickNeedMultipliers(lg, 15, 3, drafted, [1]).get(1)!.K).toBeLessThan(0.1);
    expect(pickNeedMultipliers(lg, 15, 14, drafted, [1]).get(1)!.K).toBeGreaterThan(2);
    const withK = new Map<number, string[]>([[1, [...Array(12).fill("WR"), "K"]]]);
    expect(pickNeedMultipliers(lg, 15, 14, withK, [1]).get(1)!.K).toBeLessThan(0.1);
  });

  it("cools a position once its target is met", () => {
    const stacked = new Map<number, string[]>([[1, ["RB", "RB", "RB", "RB", "RB", "RB"]]]);
    const m = pickNeedMultipliers(lg, 15, 7, stacked, [1]);
    expect(m.get(1)!.RB).toBe(0.3);
    expect(m.get(1)!.WR).toBeGreaterThan(1.4);
  });

  it("draftedPositionsFromPicks prefers the player db position", () => {
    const out = draftedPositionsFromPicks(
      [
        { roster_id: 1, player_id: "a", metadata: { position: "WR" } },
        { roster_id: 1, player_id: "b", metadata: { position: "RB" } },
        { roster_id: null, player_id: "c" },
      ],
      { a: { player_id: "a", position: "TE" } },
    );
    expect(out.get(1)).toEqual(["TE", "RB"]);
  });
});

// ---------- mock engine ----------

const row = (key: string, consensus: number, position: string): ConsensusRow => ({
  key,
  displayName: key,
  sleeperId: null,
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

const positions = ["RB", "WR", "QB", "WR", "RB", "TE"];
const board: ConsensusRow[] = Array.from({ length: 80 }, (_, i) =>
  row(`p${i + 1}`, i + 1, i >= 70 ? (i % 2 ? "K" : "DEF") : positions[i % positions.length]),
);

const redraftModel: NeedModel = { mode: "redraft", league: league(REDRAFT_SLOTS, 0), base: new Map() };
const rookieModel = (base: Map<number, Record<string, number>>): NeedModel => ({
  mode: "rookie",
  league: league(REDRAFT_SLOTS),
  base,
});

describe("mock setup", () => {
  it("builds from a Sleeper draft and resolves snake slots with traded picks", () => {
    const setup = setupFromSleeperDraft(
      draft(),
      [{ season: "2026", round: 2, roster_id: 10, previous_owner_id: 10, owner_id: 40 }],
      10,
      1,
    )!;
    expect(setup.teams).toBe(4);
    expect(slotAt(setup, 1)!.rosterId).toBe(10);
    expect(slotAt(setup, 5)).toMatchObject({ round: 2, slot: 4, rosterId: 40 });
    expect(slotAt(setup, 8)).toMatchObject({ round: 2, slot: 1, rosterId: 40 }); // R2.01 dealt to 40
    expect(myPickNumbers(setup)).toEqual([1, 9, 16, 17, 24, 25, 32, 33, 40, 41, 48, 49, 56, 57]);
  });

  it("synthetic setup puts me in my slot and shuffles the rest deterministically", () => {
    const a = syntheticSetup([1, 2, 3, 4, 5], 3, 2, 4, "snake", "2026", 7);
    const b = syntheticSetup([1, 2, 3, 4, 5], 3, 2, 4, "snake", "2026", 7);
    expect(a.slotToRoster["2"]).toBe(3);
    expect(a).toEqual(b);
    expect(new Set(Object.values(a.slotToRoster))).toEqual(new Set([1, 2, 3, 4, 5]));
  });
});

describe("advance / makePick / undo", () => {
  const setup = setupFromSleeperDraft(draft({ settings: { rounds: 3, teams: 4 } }), [], 20, 42)!;
  const empty: MockDraft = { setup, picks: [] };

  it("stops when I'm on the clock and never drafts a player twice", () => {
    const d = advance(empty, board, redraftModel, true);
    expect(d.picks).toHaveLength(1); // slot 1 picked, slot 2 (me) is up
    expect(d.picks[0].auto).toBe(true);
    const full = advance(empty, board, redraftModel, false);
    expect(full.picks).toHaveLength(12);
    expect(new Set(full.picks.map((p) => p.key)).size).toBe(12);
    expect(full.picks.filter((p) => p.mine)).toHaveLength(3);
  });

  it("is reproducible for the same seed and differs across seeds", () => {
    const a = advance(empty, board, redraftModel, false);
    const b = advance(empty, board, redraftModel, false);
    const c = advance({ setup: { ...setup, seed: 43 }, picks: [] }, board, redraftModel, false);
    expect(a.picks.map((p) => p.key)).toEqual(b.picks.map((p) => p.key));
    expect(c.picks.map((p) => p.key)).not.toEqual(a.picks.map((p) => p.key));
  });

  it("my manual pick lands in my slot and undo rewinds to before it", () => {
    let d = advance(empty, board, redraftModel, true);
    const avail = availableRows(board, d);
    expect(avail).toHaveLength(79);
    d = makePick(d, avail[5]);
    expect(d.picks[1]).toMatchObject({ mine: true, auto: false, key: avail[5].key, rosterId: 20 });
    d = advance(d, board, redraftModel, true);
    expect(d.picks.length).toBeGreaterThan(2);
    const undone = undoToMyLastPick(d);
    expect(undone.picks).toHaveLength(1);
    // the CPU's first pick is unchanged by the rewind (seeded per pick)
    expect(undone.picks[0].key).toBe(d.picks[0].key);
  });

  it("keeps real picks through an undo", () => {
    const real = { ...advance(empty, board, redraftModel, true).picks[0], real: true };
    const d = advance({ setup, picks: [real] }, board, redraftModel, false);
    expect(undoToMyLastPick(undoToMyLastPick(undoToMyLastPick(undoToMyLastPick(d)))).picks).toEqual([real]);
  });

  it("summarize ranks hauls by value and skips real picks", () => {
    const d = advance(empty, board, redraftModel, false);
    const hauls = summarize(d, (p) => 100 - parseInt(p.key.slice(1), 10));
    expect(hauls).toHaveLength(4);
    expect(hauls[0].value).toBeGreaterThanOrEqual(hauls[3].value);
    expect(hauls.flatMap((h) => h.picks)).toHaveLength(12);
  });
});

describe("cpu behaviour", () => {
  it("never reaches for a kicker early but takes one when it must", () => {
    const setup = setupFromSleeperDraft(draft({ settings: { rounds: 15, teams: 4 } }), [], null, 5)!;
    const d = advance({ setup, picks: [] }, board, redraftModel, false);
    const firstKD = d.picks.findIndex((p) => p.position === "K" || p.position === "DEF");
    expect(firstKD).toBeGreaterThan(8 * 4); // nothing before round 9 with 15 rounds
    for (const rid of [10, 20, 30, 40]) {
      const mine = d.picks.filter((p) => p.rosterId === rid);
      expect(mine.some((p) => p.position === "K")).toBe(true);
      expect(mine.some((p) => p.position === "DEF")).toBe(true);
      expect(mine.filter((p) => p.position === "QB").length).toBeLessThanOrEqual(2);
    }
  });

  it("rookie mode starts from roster appetite and cools it per pick", () => {
    const setup = setupFromSleeperDraft(draft({ settings: { rounds: 2, teams: 4 } }), [], null, 9)!;
    const model = rookieModel(new Map([[10, { RB: 1.8, WR: 0.6 }]]));
    const before = needsFor(model, { setup, picks: [] }, 10, 1);
    expect(before.RB).toBe(1.8);
    const after = needsFor(
      model,
      { setup, picks: [{ pickNo: 1, round: 1, slot: 1, rosterId: 10, key: "x", displayName: "x", position: "RB", sleeperId: null, mine: false, auto: true, real: false }] },
      10,
      2,
    );
    expect(after.RB).toBeCloseTo(1.26);
  });

  it("need weighting shifts the sampled pick", () => {
    const rand = () => 0.5;
    const neutral = cpuChoose(board, {}, rand)!;
    expect(neutral.consensus).toBeLessThanOrEqual(CONSIDERATION_SET);
    const wrOnly = cpuChoose(board, { RB: 0.01, QB: 0.01, TE: 0.01, WR: 5 }, rand)!;
    expect(wrOnly.position).toBe("WR");
    // a must-fill position pulls its best player into the pool even from deep on the board
    const mustKick = cpuChoose(board, { RB: 0.01, QB: 0.01, TE: 0.01, WR: 0.01, K: 4 }, rand)!;
    expect(mustKick.position).toBe("K");
  });
});

describe("runMocks", () => {
  it("produces an ADP and availability odds for my picks", () => {
    const setup = setupFromSleeperDraft(draft({ settings: { rounds: 3, teams: 4 } }), [], 30, 1)!;
    const res = runMocks({ setup, picks: [] }, board, redraftModel, 25);
    expect(res.runs).toBe(25);
    expect(res.myPickNos).toEqual([3, 6, 11]);
    const top = res.adp.get("p1")!;
    expect(top.n).toBe(25);
    expect(top.avg).toBeLessThan(res.adp.get("p20")?.avg ?? Infinity);
    const atThird = res.availability.get(3)!;
    // consensus #1 goes 1-2 sometimes but not always; #40 is always there
    expect(atThird.get("p40")).toBe(25);
    expect(atThird.get("p1") ?? 0).toBeLessThan(25);
  });
});
