import { describe, expect, it } from "vitest";
import {
  buildImportMarket,
  normalizeName,
  parseFantasyCalcRows,
  parseImportText,
  parsePickName,
} from "../../api/marketValues";
import { blendedPickValue, blendPlayerValues } from "../market";
import { pickValue } from "../value";
import type { PlayerValue } from "../value";
import type { PlayerMap, SleeperTradedPick } from "../../types";

const heur = (id: string, value: number): PlayerValue => ({
  playerId: id,
  value,
  winNow: value,
  ppg: 10,
  ageMult: 1,
});

describe("parsePickName", () => {
  it("parses common pick spellings", () => {
    expect(parsePickName("2027 1st")).toEqual({ season: "2027", round: 1 });
    expect(parsePickName("2027 Early 2nd")).toEqual({ season: "2027", round: 2 });
    expect(parsePickName("2028 Round 3")).toEqual({ season: "2028", round: 3 });
    expect(parsePickName("2027 Late 1st")).toEqual({ season: "2027", round: 1 });
  });
  it("rejects player names and junk", () => {
    expect(parsePickName("Ja'Marr Chase")).toBeNull();
    expect(parsePickName("2027 9th")).toBeNull();
    expect(parsePickName("first round pick")).toBeNull();
  });
});

describe("parseFantasyCalcRows", () => {
  it("joins on sleeperId and averages pick tiers", () => {
    const data = parseFantasyCalcRows(
      [
        { player: { name: "Ja'Marr Chase", sleeperId: "7564" }, value: 10000 },
        { player: { name: "Bijan Robinson", sleeperId: "9509" }, value: 9000 },
        { player: { name: "2027 Early 1st", sleeperId: null }, value: 6000 },
        { player: { name: "2027 Late 1st", sleeperId: null }, value: 3000 },
        { player: { name: "Nameless", sleeperId: null }, value: 50 },
        { value: 123 }, // malformed row
      ],
      "test",
    );
    expect(data.players).toEqual({ "7564": 10000, "9509": 9000 });
    expect(data.maxValue).toBe(10000);
    expect(data.matched).toBe(2);
    expect(data.picks).toEqual([{ season: "2027", round: 1, value: 4500 }]);
  });
});

describe("import parsing + name matching", () => {
  const players: PlayerMap = {
    "1": { player_id: "1", full_name: "Ja'Marr Chase", position: "WR", search_rank: 1 },
    "2": { player_id: "2", full_name: "Marvin Harrison Jr.", position: "WR", search_rank: 20 },
    "3": { player_id: "3", full_name: "Kenneth Walker III", position: "RB", search_rank: 40 },
  };

  it("parses csv, tsv, ranked, and plain lines", () => {
    const lines = parseImportText(
      [
        "Ja'Marr Chase, 9999",
        "Marvin Harrison Jr\t8000",
        "12. Kenneth Walker III 5000",
        "2027 1st; 4500",
        "",
        "not a valid line",
      ].join("\n"),
    );
    expect(lines).toHaveLength(4);
    expect(lines[0]).toEqual({ name: "Ja'Marr Chase", value: 9999 });
  });

  it("matches names ignoring punctuation and suffixes, routes picks", () => {
    const lines = parseImportText(
      ["Jamarr Chase, 9999", "Marvin Harrison Jr., 8000", "Kenneth Walker, 5000", "2027 1st, 4500", "Mystery Man, 1234"].join(
        "\n",
      ),
    );
    const { data, unmatched } = buildImportMarket(lines, players);
    expect(data.players).toEqual({ "1": 9999, "2": 8000, "3": 5000 });
    expect(data.picks).toEqual([{ season: "2027", round: 1, value: 4500 }]);
    expect(unmatched).toEqual(["Mystery Man"]);
  });

  it("normalizeName strips punctuation and generational suffixes", () => {
    expect(normalizeName("Marvin Harrison Jr.")).toBe("marvin harrison");
    expect(normalizeName("Kenneth Walker III")).toBe("kenneth walker");
    expect(normalizeName("Ja'Marr  Chase")).toBe("jamarr chase");
  });
});

describe("blending", () => {
  const market = {
    source: "import" as const,
    label: "t",
    fetchedAt: 0,
    players: { a: 10000, b: 2500 },
    picks: [{ season: "2027", round: 1, value: 5000 }],
    maxValue: 10000,
    matched: 2,
  };

  it("blend=0 keeps heuristic; blend=1 is pure normalized market", () => {
    const h = { a: heur("a", 40), b: heur("b", 80), c: heur("c", 30) };
    const off = blendPlayerValues(h, market, 0);
    expect(off.a.value).toBe(40);
    expect(off.a.market).toBe(10000); // raw market still annotated
    const full = blendPlayerValues(h, market, 1);
    expect(full.a.value).toBe(100); // 10000/10000 → 100
    expect(full.b.value).toBe(25); // 2500/10000 → 25
    expect(full.c.value).toBe(30); // unlisted → heuristic survives
    expect(full.c.market).toBeNull();
  });

  it("intermediate blend interpolates", () => {
    const h = { a: heur("a", 40) };
    const half = blendPlayerValues(h, market, 0.5);
    expect(half.a.value).toBe(70); // (40 + 100) / 2
  });

  it("pick values blend against the market pick board", () => {
    const pick: SleeperTradedPick = {
      season: "2027",
      round: 1,
      roster_id: 1,
      previous_owner_id: 1,
      owner_id: 2,
    };
    const heurV = pickValue(pick, "2026");
    expect(blendedPickValue(pick, "2026", null, 0.5)).toBe(heurV);
    const full = blendedPickValue(pick, "2026", market, 1);
    expect(full).toBe(50); // 5000/10000 → 50
    const none = blendedPickValue(pick, "2026", market, 0);
    expect(none).toBe(heurV);
    // pick not on the board → heuristic
    const pick2: SleeperTradedPick = { ...pick, round: 3 };
    expect(blendedPickValue(pick2, "2026", market, 1)).toBe(pickValue(pick2, "2026"));
  });
});
