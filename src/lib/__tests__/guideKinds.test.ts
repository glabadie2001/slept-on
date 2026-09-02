import { describe, expect, it } from "vitest";
import {
  buildBoard,
  defaultWeight,
  effectiveSources,
  guideWarnings,
  inferKind,
  parseAdpCsv,
  parseGuide,
} from "../guides";
import type { Guide } from "../guides";
import { deriveTendencies, describePrior, isRookieDraft, priorsByRoster, tendencyPrior, wasRookie } from "../draftHistory";
import type { HistoricalDraft } from "../draftHistory";
import { parseProjectionCsv, projectionCsvEntries, projectionPpg, sleeperProjectionEntries } from "../projections";
import { applyTendency, cpuView } from "../mockDraft";
import type { NeedModel } from "../mockDraft";
import type { ConsensusRow } from "../guides";
import type { PlayerMap, SleeperDraftPick, SleeperLeague } from "../../types";

const players: PlayerMap = {
  "10": { player_id: "10", full_name: "Ashton Jeanty", position: "RB", search_rank: 5, years_exp: 1 },
  "11": { player_id: "11", full_name: "Travis Hunter", position: "WR", search_rank: 8, years_exp: 1 },
  "12": { player_id: "12", full_name: "Cam Ward", position: "QB", search_rank: 20, years_exp: 1 },
  "13": { player_id: "13", full_name: "Tyler Warren", position: "TE", search_rank: 30, years_exp: 1 },
  "14": { player_id: "14", full_name: "Omarion Hampton", position: "RB", search_rank: 12, years_exp: 1 },
  "15": { player_id: "15", full_name: "Puka Nacua", position: "WR", search_rank: 3, years_exp: 3 },
  "16": { player_id: "16", full_name: "Jayden Daniels", position: "QB", search_rank: 15, years_exp: 1 },
  SF: { player_id: "SF", first_name: "San Francisco", last_name: "49ers", position: "DEF" },
};

const guide = (id: string, name: string, names: [string, number][], extra: Partial<Guide> = {}): Guide => ({
  id,
  name,
  addedAt: 0,
  entries: names.map(([n, rank]) => ({ name: n, rank, tier: null, position: null })),
  ...extra,
});

describe("guide kinds & weights", () => {
  it("infers kinds from names and honours explicit kinds", () => {
    expect(inferKind({ name: "Sleeper ADP (half ppr) — live" })).toBe("adp");
    expect(inferKind({ name: "KeepTradeCut Dynasty (SF)" })).toBe("market");
    expect(inferKind({ name: "FantasyCalc Redraft (1QB · 0.5 PPR) — live" })).toBe("market");
    expect(inferKind({ name: "Sleeper season projections" })).toBe("projection");
    expect(inferKind({ name: "CBS Heath Cummings Rookies (SF)" })).toBe("expert");
    expect(inferKind({ name: "whatever", kind: "history" })).toBe("history");
  });

  it("weights a consensus board high, a contributor inside it low, and splits the market budget", () => {
    const ecr = guide("a", "FantasyPros Rookie ECR (SF)", []);
    const cbs = guide("b", "CBS Heath Cummings Rookies (SF)", []);
    const ktc = guide("c", "KeepTradeCut Rookies (SF)", []);
    const fc = guide("d", "FantasyCalc Dynasty (SF) — live", []);
    const indie = guide("e", "My buddy's board", []);
    const all = [ecr, cbs, ktc, fc, indie];
    expect(defaultWeight(ecr, all)).toBe(3);
    expect(defaultWeight(cbs, all)).toBe(0.5);
    expect(defaultWeight(indie, all)).toBe(1);
    expect(defaultWeight(ktc, all)).toBe(0.75);
    expect(defaultWeight(fc, all)).toBe(0.75);
    // without ECR loaded, CBS is a full voice
    expect(defaultWeight(cbs, [cbs, ktc])).toBe(1);
    const warnings = guideWarnings(all);
    expect(warnings.some((w) => w.guideId === "b")).toBe(true);
    expect(warnings.some((w) => /trade prices/.test(w.message))).toBe(true);
  });

  it("effective sources is (Σw)²/Σw²", () => {
    expect(effectiveSources([1, 1, 1, 1])).toBe(4);
    expect(effectiveSources([3, 0.5, 0.5])).toBe(Math.round(((4 * 4) / 9.5) * 10) / 10); // ≈1.7
    expect(effectiveSources([])).toBe(0);
  });

  it("equal vs breadth weighting produce different avg/σ and the board reports nEff", () => {
    const ecr = guide("a", "FantasyPros Dynasty ECR (SF)", [["Ashton Jeanty", 1], ["Travis Hunter", 2], ["Puka Nacua", 3]]);
    const cbs = guide("b", "CBS Heath Cummings Dynasty", [["Ashton Jeanty", 3], ["Travis Hunter", 1], ["Puka Nacua", 2]]);
    const dude = guide("c", "Some Guy", [["Ashton Jeanty", 9], ["Travis Hunter", 1], ["Puka Nacua", 2]]);
    const breadth = buildBoard([ecr, cbs, dude], players);
    const equal = buildBoard([ecr, cbs, dude], players, { equal: true });
    const j = (b: typeof breadth) => b.rows.find((r) => r.displayName === "Ashton Jeanty")!;
    // breadth: weights 3 / 0.5 / 1 → avg (3·1 + 0.5·3 + 1·9)/4.5 = 3
    expect(j(breadth).avg).toBe(3);
    expect(j(equal).avg).toBeCloseTo(4.3, 1);
    expect(j(breadth).sd).not.toBe(j(equal).sd);
    expect(j(breadth).nEff).toBe(effectiveSources([3, 0.5, 1]));
    expect(breadth.nEff).toBe(effectiveSources([3, 0.5, 1]));
    expect(equal.nEff).toBe(3);
    // Some Guy's #9 costs Jeanty 1.3 places of average on the equal board, 0 on the breadth board
    expect(j(equal).avg - j(breadth).avg).toBeCloseTo(1.3, 1);
  });

  it("filters by kind so value and availability boards separate", () => {
    const ecr = guide("a", "FantasyPros ECR", [["Ashton Jeanty", 1], ["Travis Hunter", 2]]);
    const adp = guide("b", "Sleeper ADP — live", [["Travis Hunter", 1], ["Ashton Jeanty", 2]], { kind: "adp" });
    const value = buildBoard([ecr, adp], players, { kinds: ["expert", "projection", "market"] });
    const avail = buildBoard([ecr, adp], players, { kinds: ["adp", "history"] });
    expect(value.rows[0].displayName).toBe("Ashton Jeanty");
    expect(avail.rows[0].displayName).toBe("Travis Hunter");
    expect(value.guides.map((g) => g.guide.id)).toEqual(["a"]);
  });

  it("joins on the entry's Sleeper id when present, collapsing spelling variants", () => {
    const a = guide("a", "A", [["Ashton Jeanty", 1]]);
    const b: Guide = { id: "b", name: "B", addedAt: 0, entries: [{ name: "A. Jeanty", rank: 2, tier: null, position: "RB", sleeperId: "10" }] };
    const board = buildBoard([a, b], players);
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0].count).toBe(2);
    expect(board.rows[0].sleeperId).toBe("10");
  });

  it("per-guide weight overrides and zero weights drop a guide", () => {
    const a = guide("a", "A", [["Ashton Jeanty", 1]]);
    const b = guide("b", "B", [["Ashton Jeanty", 5]]);
    expect(buildBoard([a, b], players).rows[0].avg).toBe(3);
    expect(buildBoard([a, b], players, { weights: { b: 0 } }).rows[0].avg).toBe(1);
    expect(buildBoard([a, b], players, { weights: { b: 3 } }).rows[0].avg).toBe(4);
  });
});

describe("source format fixtures", () => {
  it("Underdog rankings CSV export (first/last name, adp, slotName)", () => {
    const csv = [
      "id,firstName,lastName,adp,projectedPoints,positionRank,slotName,teamName,lineupStatus,byeWeek",
      "1,Ja'Marr,Chase,1.8,310.2,WR1,WR,Cincinnati Bengals,,10",
      "2,Bijan,Robinson,1.5,301.0,RB1,RB,Atlanta Falcons,,5",
      "3,Josh,Allen,24.1,380.0,QB1,QB,Buffalo Bills,,12",
      "4,,,,,,,,,",
    ].join("\n");
    const { entries, skipped } = parseGuide(csv);
    expect(entries.map((e) => e.name)).toEqual(["Bijan Robinson", "Ja'Marr Chase", "Josh Allen"]);
    expect(entries[0]).toMatchObject({ rank: 1, position: "RB" });
    expect(entries[2]).toMatchObject({ rank: 3, position: "QB" });
    expect(skipped).toBe(1);
  });

  it("NFFC ADP table paste (Rank, Player, Team, Pos, ADP, Min, Max, %)", () => {
    const text = [
      "Rank\tPlayer\tTeam\tPos\tADP\tMin\tMax\tDrafted",
      "1\tBijan Robinson\tATL\tRB\t1.31\t1\t3\t100%",
      "2\tJa'Marr Chase\tCIN\tWR\t2.02\t1\t4\t100%",
      "3\tSaquon Barkley\tPHI\tRB\t3.10\t2\t6\t100%",
    ].join("\n");
    const { entries } = parseGuide(text);
    expect(entries.map((e) => e.name)).toEqual(["Bijan Robinson", "Ja'Marr Chase", "Saquon Barkley"]);
    expect(entries[1]).toMatchObject({ rank: 2, position: "WR" });
  });

  it("ADP CSV with a single Player column orders by ADP, not file order", () => {
    const csv = ["Player,Pos,Team,ADP", "Josh Allen,QB,BUF,22.4", "Bijan Robinson,RB,ATL,1.2", "Brock Bowers,TE,LV,18.0"].join("\n");
    const out = parseAdpCsv(csv)!;
    expect(out.entries.map((e) => e.name)).toEqual(["Bijan Robinson", "Brock Bowers", "Josh Allen"]);
    expect(parseAdpCsv("1. Bijan Robinson\n2. Josh Allen")).toBeNull();
  });

  it("DLF-style dynasty ADP paste with a dotted ADP column and DST/PK codes", () => {
    const text = [
      "Rank, Name, Position, ADP",
      "1, Ja'Marr Chase, WR1, 1.5",
      "2, Bijan Robinson, RB1, 2.1",
      "40, San Francisco 49ers, DST, 190.4",
      "41, Justin Tucker, PK, 200.2",
    ].join("\n");
    const { entries } = parseGuide(text);
    expect(entries[2]).toMatchObject({ name: "San Francisco 49ers", position: "DEF" });
    expect(entries[3]).toMatchObject({ name: "Justin Tucker", position: "K" });
  });

  it("projection CSV maps columns to Sleeper stat keys and scores under league rules", () => {
    const csv = [
      'Player,Team,POS,PASS YDS,PASS TDS,INTS,RUSH YDS,RUSH TDS,REC,REC YDS,REC TDS,FL,FPTS',
      '"Josh Allen",BUF,QB,4200,32,12,520,10,0,0,0,3,380.1',
      '"Bijan Robinson",ATL,RB,0,0,0,1400,14,60,450,3,2,290.0',
      '"Ja\'Marr Chase",CIN,WR,0,0,0,20,0,105,1400,11,1,320.0',
    ].join("\n");
    const parsed = parseProjectionCsv(csv)!;
    expect(parsed.mapped).toEqual(["pass_yd", "pass_td", "pass_int", "rush_yd", "rush_td", "rec", "rec_yd", "rec_td", "fum_lost"]);
    expect(parsed.unmapped).toEqual(["FPTS"]);
    // 1QB-ish scoring where passing TDs are 4: Allen = 168+128-12+52+60-6 = 390
    const scoring = { pass_yd: 0.04, pass_td: 4, pass_int: -1, rush_yd: 0.1, rush_td: 6, rec: 1, rec_yd: 0.1, rec_td: 6, fum_lost: -2 };
    const entries = projectionCsvEntries(parsed, scoring);
    expect(entries[0]).toMatchObject({ name: "Josh Allen", rank: 1, position: "QB" });
    // half-PPR, TE premium irrelevant: Chase = 2 + 52.5 + 140 + 66 - 2 = 258.5 vs Robinson 140+84+30+45+18-4 = 313
    const half = projectionCsvEntries(parsed, { ...scoring, rec: 0.5 });
    expect(half.map((e) => e.name)).toEqual(["Josh Allen", "Bijan Robinson", "Ja'Marr Chase"]);
    expect(parseProjectionCsv("1. Bijan Robinson\n2. Josh Allen")).toBeNull();
  });

  it("Sleeper projection rows become a ranked, id-joined guide; PPG falls back to 17 games", () => {
    const scoring = { rush_yd: 0.1, rec: 1, rec_yd: 0.1, pass_yd: 0.04 };
    const entries = sleeperProjectionEntries(
      [
        { player_id: "10", stats: { rush_yd: 1200, rec: 40, rec_yd: 300 } },
        { player_id: "15", stats: { rec: 100, rec_yd: 1400 } },
        { player_id: "999", stats: { rec: 5 } },
        { player_id: "12", stats: { pass_yd: 0 } },
      ],
      scoring,
      players,
    );
    expect(entries.map((e) => e.name)).toEqual(["Puka Nacua", "Ashton Jeanty"]);
    expect(entries[0].sleeperId).toBe("15");
    expect(projectionPpg({ rec: 100, rec_yd: 1400 }, scoring)).toBeCloseTo(240 / 17, 2);
    expect(projectionPpg({ rec: 100, rec_yd: 1400, gp: 16 }, scoring)).toBe(15);
  });
});

// ---------- league draft history ----------

const pick = (pick_no: number, teams: number, picked_by: string, player_id: string, position: string): SleeperDraftPick => ({
  round: Math.ceil(pick_no / teams),
  pick_no,
  draft_slot: ((pick_no - 1) % teams) + 1,
  roster_id: null,
  player_id,
  picked_by,
  metadata: { position },
});

describe("draft history tendencies", () => {
  const teams = 2;
  // 2-team, 4-round drafts: owner u1 takes a QB at pick 1 every year, u2 waits.
  const draft = (season: string, id: string, adp: Record<string, number> | null): HistoricalDraft => ({
    season,
    draftId: id,
    type: "snake",
    rounds: 4,
    teams,
    rookieDraft: false,
    adp,
    picks: [
      pick(1, teams, "u1", "12", "QB"),
      pick(2, teams, "u2", "10", "RB"),
      pick(3, teams, "u2", "15", "WR"),
      pick(4, teams, "u1", "14", "RB"),
      pick(5, teams, "u1", "13", "TE"),
      pick(6, teams, "u2", "16", "QB"),
      pick(7, teams, "u2", "SF", "DEF"),
      pick(8, teams, "u1", "SF", "DEF"),
    ],
  });
  const adp = { "12": 7, "10": 1, "15": 2, "14": 3, "13": 6, "16": 5 };

  it("derives per-owner timing, RB lean, reach and rookie share", () => {
    const t = deriveTendencies([draft("2025", "d1", adp), draft("2024", "d2", adp)], players, "2026", new Set(["u1", "u2"]));
    const u1 = t.owners.get("u1")!;
    const u2 = t.owners.get("u2")!;
    expect(t.drafts).toBe(2);
    expect(u1.drafts).toBe(2);
    expect(u1.firstQb).toBe(0); // pick 1
    expect(u2.firstQb).toBeCloseTo(5 / 8); // pick 6
    expect(t.league.firstQb).toBeCloseTo((0 + 5 / 8) / 2);
    expect(u1.firstTe).toBeCloseTo(4 / 8);
    expect(u2.rbShareEarly).toBe(0.5); // RB + WR in picks 1-3
    expect(u1.reach!).toBeGreaterThan(u2.reach!); // QB at 1 with ADP 7 = big reach
    // rookies in 2025 per today's years_exp (1) → yes for the young guys, no for Nacua
    expect(u2.rookieShare).toBeCloseTo(2 / 3); // Jeanty, Daniels rookies; Nacua not (DEF has no years_exp → skipped)
    expect(wasRookie(players, "15", "2025", "2026")).toBe(false);
    expect(wasRookie(players, "SF", "2025", "2026")).toBeNull();
  });

  it("ignores owners no longer in the league", () => {
    const t = deriveTendencies([draft("2025", "d1", null)], players, "2026", new Set(["u1"]));
    expect(t.owners.has("u2")).toBe(false);
    expect(t.league.firstQb).toBe(0); // pooled only over kept owners' picks
  });

  it("shrinks toward the league prior with k drafts of pseudo-evidence", () => {
    const t = deriveTendencies([draft("2025", "d1", adp), draft("2024", "d2", adp)], players, "2026", new Set(["u1", "u2"]));
    const loose = tendencyPrior(t.owners.get("u1")!, t.league, 0);
    const tight = tendencyPrior(t.owners.get("u1")!, t.league, 8);
    expect(loose.confidence).toBe(1);
    expect(tight.confidence).toBeCloseTo(0.2);
    expect(loose.qbEarly).toBeGreaterThan(1);
    expect(tight.qbEarly).toBeGreaterThan(1);
    expect(tight.qbEarly - 1).toBeLessThan(loose.qbEarly - 1);
    expect(loose.reach).toBeGreaterThan(1);
    const byRoster = priorsByRoster(t, new Map([[1, "u1"], [2, "u2"], [3, "ghost"], [4, null]]), 2);
    expect(byRoster.get(3)!.confidence).toBe(0);
    expect(byRoster.get(4)!.qbEarly).toBe(1);
    expect(describePrior(loose).some((s) => /QBs early/.test(s))).toBe(true);
    expect(isRookieDraft({ rounds: 4 }, 16)).toBe(true);
    expect(isRookieDraft({ rounds: 15 }, 16)).toBe(false);
  });

  it("tendency priors bend appetite until the position is filled; CPU view follows ADP order", () => {
    const prior = { userId: "u1", drafts: 2, qbEarly: 1.8, teEarly: 1, rbLean: 1.3, reach: 1.2, rookieLean: 1, confidence: 1 };
    const need = { QB: 1, RB: 1, WR: 1, TE: 1 };
    const early = applyTendency(need, prior, [], 1, 15);
    expect(early.QB).toBeCloseTo(1.8);
    expect(early.RB).toBeCloseTo(1.3);
    expect(early.WR).toBeCloseTo(0.7);
    const later = applyTendency(need, prior, ["QB"], 8, 15);
    expect(later.QB).toBe(1);
    expect(later.RB).toBe(1);
    expect(applyTendency(need, undefined, [], 1, 15)).toBe(need);

    const row = (key: string, consensus: number): ConsensusRow => ({ key, displayName: key, sleeperId: null, position: "WR", ranks: {}, avg: consensus, best: consensus, worst: consensus, sd: 0, tier: null, count: 1, nEff: 1, consensus });
    const board = [row("a", 1), row("b", 2), row("c", 3)];
    const model: NeedModel = { mode: "redraft", league: {} as SleeperLeague, base: new Map(), cpuRank: new Map([["c", 1], ["a", 2]]) };
    expect(cpuView(board, model).map((r) => r.key)).toEqual(["c", "a", "b"]); // b unranked → after
    expect(cpuView(board, { ...model, cpuRank: undefined }).map((r) => r.key)).toEqual(["a", "b", "c"]);
  });
});
