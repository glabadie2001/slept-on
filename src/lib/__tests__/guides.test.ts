import { describe, expect, it } from "vitest";
import { aggregateGuides, buildNameIndex, parseGuide } from "../guides";
import { fantasyCalcRowsToEntries, sleeperAdpKeys, sleeperAdpRowsToEntries } from "../../api/liveGuides";
import type { SleeperLeague } from "../../types";
import type { Guide } from "../guides";
import type { PlayerMap } from "../../types";

describe("parseGuide", () => {
  it("parses ranked lines with position/team decorations", () => {
    const { entries } = parseGuide(
      [
        "1. Ashton Jeanty, RB, LV",
        "2. Travis Hunter WR JAX",
        "3) Omarion Hampton",
        "Cam Ward (QB)",
      ].join("\n"),
    );
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({ name: "Ashton Jeanty", rank: 1, position: "RB" });
    expect(entries[1]).toMatchObject({ name: "Travis Hunter", rank: 2, position: "WR" });
    expect(entries[2]).toMatchObject({ name: "Omarion Hampton", rank: 3, position: null });
    expect(entries[3]).toMatchObject({ name: "Cam Ward", rank: 4 });
  });

  it("parses CSV with a header row and explicit rank column", () => {
    const { entries } = parseGuide(
      ["Rank,Player,Pos,Team", "1,Ashton Jeanty,RB,LV", "2,Tetairoa McMillan,WR,CAR"].join("\n"),
    );
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ name: "Tetairoa McMillan", rank: 2, position: "WR" });
  });

  it("assigns implicit ranks to bare-name lists and tracks tiers", () => {
    const { entries } = parseGuide(
      ["Tier 1", "Ashton Jeanty", "Travis Hunter", "Tier 2", "Omarion Hampton"].join("\n"),
    );
    expect(entries.map((e) => e.rank)).toEqual([1, 2, 3]);
    expect(entries.map((e) => e.tier)).toEqual([1, 1, 2]);
  });

  it("does not mangle suffixed names or treat suffixes as teams", () => {
    const { entries } = parseGuide("1. Kenneth Walker III, RB, SEA\n2. Marvin Harrison Jr. WR ARI");
    expect(entries[0].name).toBe("Kenneth Walker III");
    expect(entries[1].name).toBe("Marvin Harrison Jr.");
  });

  it("skips junk and reports it", () => {
    const { entries, skipped } = parseGuide("1. Real Player\n---\n42\n2. Other Player");
    expect(entries).toHaveLength(2);
    expect(skipped).toBeGreaterThanOrEqual(1);
  });
});

describe("aggregateGuides", () => {
  const players: PlayerMap = {
    "10": { player_id: "10", full_name: "Ashton Jeanty", position: "RB", search_rank: 5 },
    "11": { player_id: "11", full_name: "Travis Hunter", position: "WR", search_rank: 8 },
  };

  const guide = (id: string, names: [string, number][]): Guide => ({
    id,
    name: id,
    addedAt: 0,
    entries: names.map(([name, rank]) => ({ name, rank, tier: null, position: null })),
  });

  it("averages ranks across guides and orders the board", () => {
    const rows = aggregateGuides(
      [
        guide("a", [["Ashton Jeanty", 1], ["Travis Hunter", 2], ["Mystery Rookie", 3]]),
        guide("b", [["Travis Hunter", 1], ["Ashton Jeanty", 3]]),
      ],
      players,
    );
    const jeanty = rows.find((r) => r.displayName === "Ashton Jeanty")!;
    const hunter = rows.find((r) => r.displayName === "Travis Hunter")!;
    const mystery = rows.find((r) => r.displayName === "Mystery Rookie")!;
    expect(jeanty.avg).toBe(2); // (1+3)/2
    expect(hunter.avg).toBe(1.5); // (2+1)/2
    expect(hunter.consensus).toBe(1);
    expect(jeanty.consensus).toBe(2);
    expect(jeanty.best).toBe(1);
    expect(jeanty.worst).toBe(3);
    expect(jeanty.sd).toBe(1);
    expect(jeanty.sleeperId).toBe("10");
    expect(jeanty.position).toBe("RB");
    // unmatched names still aggregate, just without a Sleeper link
    expect(mystery.sleeperId).toBeNull();
    expect(mystery.count).toBe(1);
  });

  it("matches names case/punctuation-insensitively across guides", () => {
    const rows = aggregateGuides(
      [guide("a", [["ashton jeanty", 1]]), guide("b", [["Ashton  Jeanty", 2]])],
      players,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(2);
    expect(rows[0].avg).toBe(1.5);
  });

  it("prefers breadth on avg ties and keeps the better duplicate rank", () => {
    const rows = aggregateGuides(
      [
        guide("a", [["Ashton Jeanty", 2], ["Ashton Jeanty", 5], ["Travis Hunter", 2]]),
        guide("b", [["Ashton Jeanty", 2]]),
      ],
      players,
    );
    const jeanty = rows.find((r) => r.displayName === "Ashton Jeanty")!;
    expect(jeanty.ranks.a).toBe(2); // duplicate kept the better rank
    expect(jeanty.avg).toBe(2);
    expect(jeanty.consensus).toBe(1); // ties (avg 2) break toward 2-guide breadth
  });

  it("buildNameIndex prefers the market-relevant player on collisions", () => {
    const dupes: PlayerMap = {
      "1": { player_id: "1", full_name: "Josh Allen", position: "QB", search_rank: 3 },
      "2": { player_id: "2", full_name: "Josh Allen", position: "TE", search_rank: 900 },
    };
    expect(buildNameIndex(dupes).get("josh allen")).toBe("1");
  });
});

describe("live guide feeds → entries", () => {
  const players: PlayerMap = {
    "10": { player_id: "10", full_name: "Ashton Jeanty", position: "RB" },
    "11": { player_id: "11", full_name: "Travis Hunter", position: "WR" },
    SF: { player_id: "SF", first_name: "San Francisco", last_name: "49ers", position: "DEF" },
  };
  const league = (positions: string[], rec: number): SleeperLeague =>
    ({ roster_positions: positions, scoring_settings: { rec }, total_rosters: 12, season: "2026" }) as unknown as SleeperLeague;

  it("FantasyCalc rows rank by value, skip picks, use Sleeper names", () => {
    const entries = fantasyCalcRowsToEntries(
      [
        { player: { name: "Travis Hunter Jr.", sleeperId: "11", position: "WR" }, value: 5000 },
        { player: { name: "2027 1st", sleeperId: null, position: null }, value: 6000 },
        { player: { name: "Ashton Jeanty", sleeperId: "10", position: "RB" }, value: 9000 },
      ],
      players,
    );
    expect(entries.map((e) => e.name)).toEqual(["Ashton Jeanty", "Travis Hunter"]);
    expect(entries[0]).toMatchObject({ rank: 1, position: "RB" });
  });

  it("Sleeper ADP keys follow QB format, scoring and draft mode", () => {
    expect(sleeperAdpKeys(league(["QB", "FLEX"], 0.5), "redraft")[0]).toBe("adp_half_ppr");
    expect(sleeperAdpKeys(league(["QB", "SUPER_FLEX"], 1), "redraft")[0]).toBe("adp_2qb");
    expect(sleeperAdpKeys(league(["QB"], 1), "startup")[0]).toBe("adp_dynasty_ppr");
    expect(sleeperAdpKeys(league(["QB"], 0), "rookie")[0]).toBe("adp_rookie");
  });

  it("Sleeper ADP rows fall back to the first key enough rows carry, sorted ascending", () => {
    const rows = [
      { player_id: "11", stats: { adp_half_ppr: 12.4 } },
      { player_id: "10", stats: { adp_half_ppr: 1.2 } },
      { player_id: "SF", stats: { adp_half_ppr: 150 } },
      { player_id: "99", stats: { adp_half_ppr: 3 } }, // unknown player, skipped
    ];
    const out = sleeperAdpRowsToEntries(rows, players, ["adp_2qb", "adp_half_ppr"], 3);
    expect(out.key).toBe("adp_half_ppr");
    expect(out.entries.map((e) => e.name)).toEqual(["Ashton Jeanty", "Travis Hunter", "San Francisco 49ers"]);
    expect(out.entries[2].position).toBe("DEF");
    expect(sleeperAdpRowsToEntries(rows, players, ["adp_2qb"], 3).key).toBeNull();
  });
});
