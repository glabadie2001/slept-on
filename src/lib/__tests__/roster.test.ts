import { describe, expect, it } from "vitest";
import type { PlayerMap, SleeperLeague, SleeperPlayer, SleeperRoster, SleeperTradedPick } from "../../types";
import {
  activeCapacity,
  activeIds,
  holdBadge,
  irAdvice,
  rosterCrunch,
  taxiAdvice,
  upgradePairs,
} from "../roster";

function mkLeague(overrides: Partial<SleeperLeague["settings"]> = {}): SleeperLeague {
  return {
    league_id: "L1",
    name: "Test",
    season: "2026",
    status: "in_season",
    sport: "nfl",
    total_rosters: 2,
    roster_positions: ["QB", "RB", "WR", "BN", "BN", "IR"],
    scoring_settings: {},
    settings: { taxi_slots: 2, reserve_slots: 1, ...overrides },
    previous_league_id: null,
    avatar: null,
  };
}

function mkPlayer(id: string, pos: string, overrides: Partial<SleeperPlayer> = {}): SleeperPlayer {
  return {
    player_id: id,
    full_name: `Player ${id}`,
    position: pos,
    fantasy_positions: [pos],
    team: "KC",
    age: 26,
    years_exp: 4,
    injury_status: null,
    ...overrides,
  };
}

function mkRoster(overrides: Partial<SleeperRoster> = {}): SleeperRoster {
  return {
    roster_id: 1,
    owner_id: "u1",
    league_id: "L1",
    players: [],
    starters: [],
    settings: { wins: 0, losses: 0, ties: 0, fpts: 0 },
    ...overrides,
  };
}

const vals = (m: Record<string, number>) =>
  Object.fromEntries(Object.entries(m).map(([id, value]) => [id, { value }]));

describe("activeCapacity / activeIds", () => {
  it("counts BN but not IR/TAXI slots", () => {
    expect(activeCapacity(mkLeague())).toBe(5);
  });

  it("excludes reserve and taxi members from the active roster", () => {
    const r = mkRoster({ players: ["a", "b", "c", "d"], reserve: ["c"], taxi: ["d"] });
    expect(activeIds(r)).toEqual(["a", "b"]);
  });
});

describe("irAdvice", () => {
  const players: PlayerMap = {
    hurt: mkPlayer("hurt", "WR", { injury_status: "Out" }),
    fine: mkPlayer("fine", "RB"),
    q: mkPlayer("q", "WR", { injury_status: "Questionable" }),
  };

  it("suggests stashing an IR-eligible active player when a slot is open", () => {
    const r = mkRoster({ players: ["hurt", "fine"], reserve: [] });
    const advice = irAdvice(mkLeague(), r, players);
    expect(advice).toHaveLength(1);
    expect(advice[0]).toMatchObject({ kind: "stash", playerId: "hurt" });
  });

  it("suggests nothing when reserve slots are full", () => {
    const r = mkRoster({ players: ["hurt", "fine", "q"], reserve: ["q"] });
    // "q" is Questionable, so it also flags him as activation-needed — but no
    // stash for "hurt" since the slot is occupied.
    const advice = irAdvice(mkLeague(), r, players);
    expect(advice.filter((a) => a.kind === "stash")).toHaveLength(0);
  });

  it("does not stash merely Questionable players", () => {
    const r = mkRoster({ players: ["q", "fine"], reserve: [] });
    expect(irAdvice(mkLeague(), r, players)).toHaveLength(0);
  });

  it("flags a healthy player parked in an IR slot", () => {
    const r = mkRoster({ players: ["fine", "hurt"], reserve: ["fine"] });
    const advice = irAdvice(mkLeague(), r, players);
    expect(advice.some((a) => a.kind === "activate" && a.playerId === "fine")).toBe(true);
  });
});

describe("upgradePairs", () => {
  const players: PlayerMap = {
    myStar: mkPlayer("myStar", "WR"),
    myScrub: mkPlayer("myScrub", "WR"),
    fa: mkPlayer("fa", "WR"),
    faNoTeam: mkPlayer("faNoTeam", "WR", { team: null }),
    faHurt: mkPlayer("faHurt", "WR", { injury_status: "IR" }),
    theirGuy: mkPlayer("theirGuy", "WR"),
  };
  const proj = (m: Record<string, number>) => (id: string) => m[id] ?? 0;

  it("pairs a weak bench hold with a clearly better free agent", () => {
    const mine = mkRoster({ players: ["myStar", "myScrub"], starters: ["myStar"] });
    const theirs = mkRoster({ roster_id: 2, players: ["theirGuy"] });
    const pairs = upgradePairs(
      mine,
      [mine, theirs],
      players,
      vals({ myStar: 80, myScrub: 2, fa: 20, faHurt: 90, theirGuy: 95 }),
      proj({ myStar: 20, myScrub: 2, fa: 10 }),
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ dropId: "myScrub", addId: "fa", position: "WR" });
    expect(pairs[0].netValue).toBe(18);
    // never suggests dropping a starter
    expect(pairs.some((p) => p.dropId === "myStar")).toBe(false);
  });

  it("ignores rostered players, free agents without a team, and ruled-out free agents", () => {
    const mine = mkRoster({ players: ["myScrub"] });
    const theirs = mkRoster({ roster_id: 2, players: ["theirGuy", "fa"] });
    const pairs = upgradePairs(
      mine,
      [mine, theirs],
      players,
      vals({ myScrub: 2, fa: 50, faNoTeam: 50, faHurt: 50, theirGuy: 95 }),
      proj({}),
    );
    expect(pairs).toHaveLength(0);
  });

  it("respects the margin — a marginal upgrade is not worth a drop", () => {
    const mine = mkRoster({ players: ["myScrub"] });
    const pairs = upgradePairs(mine, [mine], players, vals({ myScrub: 10, fa: 11 }), proj({}));
    expect(pairs).toHaveLength(0);
  });
});

describe("taxiAdvice", () => {
  const players: PlayerMap = {
    qb1: mkPlayer("qb1", "QB"),
    rb1: mkPlayer("rb1", "RB"),
    wr1: mkPlayer("wr1", "WR"),
    taxiQb: mkPlayer("taxiQb", "QB", { age: 22, years_exp: 0 }),
    rookie: mkPlayer("rookie", "WR", { age: 22, years_exp: 0 }),
    vet: mkPlayer("vet", "WR", { age: 29, years_exp: 7 }),
  };
  const proj = (m: Record<string, number>) => (id: string) => m[id] ?? 0;

  it("suggests promoting a taxi player who clearly improves the lineup, marked irreversible", () => {
    const r = mkRoster({ players: ["qb1", "rb1", "wr1", "taxiQb"], taxi: ["taxiQb"] });
    const { moves } = taxiAdvice(mkLeague(), r, players, vals({}), proj({ qb1: 10, rb1: 8, wr1: 9, taxiQb: 25 }));
    const promote = moves.find((m) => m.kind === "promote");
    expect(promote).toMatchObject({ playerId: "taxiQb", irreversible: true, gain: 15 });
  });

  it("does not suggest promoting a taxi player who wouldn't crack the lineup", () => {
    const r = mkRoster({ players: ["qb1", "rb1", "wr1", "taxiQb"], taxi: ["taxiQb"] });
    const { moves } = taxiAdvice(mkLeague(), r, players, vals({}), proj({ qb1: 20, rb1: 8, wr1: 9, taxiQb: 5 }));
    expect(moves.filter((m) => m.kind === "promote")).toHaveLength(0);
  });

  it("suggests stashing an eligible rookie riding the active bench while slots are open", () => {
    const r = mkRoster({ players: ["qb1", "rb1", "wr1", "rookie"], taxi: [] });
    const { open, moves } = taxiAdvice(
      mkLeague(),
      r,
      players,
      vals({ rookie: 15 }),
      proj({ qb1: 20, rb1: 8, wr1: 9, rookie: 1 }),
    );
    expect(open).toBe(2);
    expect(moves.find((m) => m.kind === "stash")).toMatchObject({ playerId: "rookie", irreversible: false });
  });

  it("never suggests stashing veterans or when no slots are open", () => {
    const noVet = mkRoster({ players: ["qb1", "wr1", "vet"], taxi: [] });
    expect(
      taxiAdvice(mkLeague(), noVet, players, vals({}), proj({ qb1: 20, wr1: 9, vet: 1 })).moves,
    ).toHaveLength(0);

    const full = mkRoster({ players: ["qb1", "rb1", "wr1", "rookie", "taxiQb"], taxi: ["taxiQb", "rookie"] });
    const { moves } = taxiAdvice(mkLeague(), full, players, vals({}), proj({ qb1: 20, rb1: 8, wr1: 9 }));
    expect(moves.filter((m) => m.kind === "stash")).toHaveLength(0);
  });
});

describe("rosterCrunch", () => {
  it("projects cuts from incoming rookie picks vs open spots", () => {
    const r = mkRoster({ players: ["a", "b", "c", "d"], taxi: ["d"] }); // 3 active of 5 capacity
    const picks: SleeperTradedPick[] = [
      // my 2027 2nd traded away
      { season: "2027", round: 2, roster_id: 1, previous_owner_id: 1, owner_id: 2 },
      // two 2027 picks acquired
      { season: "2027", round: 1, roster_id: 2, previous_owner_id: 2, owner_id: 1 },
      { season: "2027", round: 3, roster_id: 2, previous_owner_id: 2, owner_id: 1 },
      // a different season — ignored
      { season: "2028", round: 1, roster_id: 1, previous_owner_id: 1, owner_id: 2 },
    ];
    const c = rosterCrunch(mkLeague(), r, picks, "2026");
    expect(c).toMatchObject({ capacity: 5, active: 3, open: 2, nextSeason: "2027", incomingPicks: 5, cutsNeeded: 3 });
  });

  it("reports zero cuts when there's room", () => {
    const r = mkRoster({ players: ["a"] });
    const c = rosterCrunch(mkLeague(), r, [], "2026");
    expect(c.cutsNeeded).toBe(0);
    expect(c.incomingPicks).toBe(4); // native rounds intact
  });
});

describe("holdBadge", () => {
  it("matches the Dynasty tab thresholds", () => {
    expect(holdBadge(22, 10)).toBe("young-core");
    expect(holdBadge(24, 5)).toBe("young-core");
    expect(holdBadge(28, 15)).toBe("sell-window");
    expect(holdBadge(28, 5)).toBeNull();
    expect(holdBadge(25, 50)).toBeNull();
    expect(holdBadge(null, 50)).toBeNull();
  });
});
