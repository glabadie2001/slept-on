import { describe, expect, it } from "vitest";
import type { PlayerMap, SleeperPlayer, SleeperRoster, StatLine } from "../../types";
import { usageOf, waiverWatchdog } from "../watchdog";

const SCORING = { rec: 1, rec_yd: 0.1, rec_td: 6 };

function mkPlayer(id: string, overrides: Partial<SleeperPlayer> = {}): SleeperPlayer {
  return {
    player_id: id,
    full_name: `Player ${id}`,
    position: "WR",
    team: "LAR",
    age: 24,
    years_exp: 3,
    ...overrides,
  };
}

function mkRoster(ids: string[]): SleeperRoster {
  return {
    roster_id: 1,
    owner_id: "u1",
    league_id: "L1",
    players: ids,
    starters: [],
    settings: { wins: 0, losses: 0, ties: 0, fpts: 0 },
  };
}

// A quiet-then-eruption WR: 3.1 → 4.1 → 8.8 → 22.6 pts, targets 2/3/7/12.
const RAMP: Record<number, StatLine> = {
  1: { rec: 1, rec_yd: 21, rec_tgt: 2 },
  2: { rec: 2, rec_yd: 21, rec_tgt: 3 },
  3: { rec: 4, rec_yd: 48, rec_tgt: 7 },
  4: { rec: 7, rec_yd: 96, rec_td: 1, rec_tgt: 12 },
};

// A steady veteran: same modest line every week.
const FLAT: StatLine = { rec: 3, rec_yd: 40, rec_tgt: 4 };

function statsFor(perPlayer: Record<string, Record<number, StatLine | undefined>>) {
  const out: Record<number, Record<string, StatLine>> = {};
  for (const [pid, byWeek] of Object.entries(perPlayer)) {
    for (const [w, line] of Object.entries(byWeek)) {
      if (!line) continue;
      (out[Number(w)] ??= {})[pid] = line;
    }
  }
  return out;
}

describe("waiverWatchdog", () => {
  const players: PlayerMap = {
    ramp: mkPlayer("ramp", { years_exp: 0 }),
    flat: mkPlayer("flat", { years_exp: 8 }),
    mine: mkPlayer("mine"),
  };

  it("flags a points+usage ramp as a breakout and puts it first", () => {
    const recent = statsFor({
      ramp: RAMP,
      flat: { 1: FLAT, 2: FLAT, 3: FLAT, 4: FLAT },
    });
    const alerts = waiverWatchdog([mkRoster(["mine"])], players, recent, SCORING, [], {});
    const top = alerts[0];
    expect(top.playerId).toBe("ramp");
    expect(top.tier).toBe("breakout");
    expect(top.lastWeekPts).toBeCloseTo(22.6, 1);
    expect(top.lastWeek).toBe(4);
    expect(top.usageStreak).toBe(3);
    expect(top.baselinePpg).toBeCloseTo(5.3, 1);
    expect(top.signals.join(" ")).toContain("rookie WR");
  });

  it("never flags rostered players", () => {
    const recent = statsFor({ mine: RAMP });
    const alerts = waiverWatchdog([mkRoster(["mine"])], players, recent, SCORING, [], {});
    expect(alerts).toHaveLength(0);
  });

  it("returns nothing with no completed weeks (offseason)", () => {
    expect(waiverWatchdog([mkRoster([])], players, {}, SCORING, [], {})).toHaveLength(0);
  });

  it("does not call a steady veteran a breakout", () => {
    const recent = statsFor({ flat: { 1: FLAT, 2: FLAT, 3: FLAT, 4: FLAT } });
    const alerts = waiverWatchdog([mkRoster([])], players, recent, SCORING, [], {});
    for (const a of alerts) expect(a.tier).not.toBe("breakout");
  });

  it("skips players whose last stat line is stale", () => {
    // Big week 1, silent since — old news, not a breakout in progress.
    const recent = statsFor({
      ramp: { 1: RAMP[4] },
      flat: { 1: FLAT, 2: FLAT, 3: FLAT, 4: FLAT },
    });
    const alerts = waiverWatchdog([mkRoster([])], players, recent, SCORING, [], {});
    expect(alerts.find((a) => a.playerId === "ramp")).toBeUndefined();
  });

  it("uses last-season PPG as the baseline when only one recent week exists", () => {
    const recent = statsFor({ ramp: { 4: RAMP[4] } });
    const lastSeason = { ramp: { rec: 32, rec_yd: 400, gp: 16 } }; // 4.5 ppg
    const alerts = waiverWatchdog([mkRoster([])], players, recent, SCORING, [], lastSeason);
    expect(alerts[0]?.baselinePpg).toBeCloseTo(4.5, 1);
  });

  it("boosts and mentions league-wide add trends", () => {
    const recent = statsFor({ ramp: RAMP });
    const alerts = waiverWatchdog(
      [mkRoster([])],
      players,
      recent,
      SCORING,
      [{ player_id: "ramp", count: 4200 }],
      {},
    );
    expect(alerts[0].trendCount).toBe(4200);
    expect(alerts[0].signals.join(" ")).toContain("4,200 adds");
  });
});

describe("waiverWatchdog on the demo league", () => {
  it("catches the planted breakout rookie (Keon Sparks) as a breakout", async () => {
    const { buildDemoBundle } = await import("../../demo/demoData");
    const b = buildDemoBundle();
    const alerts = waiverWatchdog(
      b.rosters,
      b.players,
      b.recentStats,
      b.league.scoring_settings,
      b.trendingAdds,
      b.lastSeasonStats,
    );
    const sparks = alerts.find((a) => b.players[a.playerId]?.full_name === "Keon Sparks");
    expect(sparks).toBeDefined();
    expect(sparks!.tier).toBe("breakout");
    expect(alerts[0]).toBe(sparks);
  });
});

describe("usageOf", () => {
  it("prefers targets, adding carries and pass attempts", () => {
    expect(usageOf({ rec_tgt: 8, rec: 5, rush_att: 2 })).toBe(10);
    expect(usageOf({ pass_att: 30, rush_att: 6 })).toBe(36);
  });
  it("falls back to receptions when targets are missing", () => {
    expect(usageOf({ rec: 5 })).toBe(5);
    expect(usageOf(undefined)).toBe(0);
  });
});
