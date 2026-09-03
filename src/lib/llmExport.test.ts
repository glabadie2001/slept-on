import { describe, expect, it } from "vitest";
import { buildLlmExport } from "./llmExport";
import { reviewDraft } from "./draftReview";
import type { ConsensusRow } from "./guides";
import type { PlayerMap, SleeperDraftPick, SleeperLeague } from "../types";

const row = (id: string, name: string, consensus: number, position: string): ConsensusRow => ({
  key: name.toLowerCase(), displayName: name, sleeperId: id, position, ranks: {}, avg: consensus,
  best: consensus, worst: consensus, sd: 0, tier: null, count: 1, nEff: 1, consensus,
});
const pick = (pick_no: number, roster_id: number, player_id: string): SleeperDraftPick => ({
  round: Math.ceil(pick_no / 2), pick_no, draft_slot: ((pick_no - 1) % 2) + 1, roster_id, player_id, picked_by: "u",
});
const players = { p1: { full_name: "Alpha", position: "RB", team: "DET" }, p2: { full_name: "Bravo", position: "WR", team: "CIN" }, p3: { full_name: "Charlie", position: "RB", team: "SF" } } as unknown as PlayerMap;
const league = { name: "Test", season: "2026", total_rosters: 2, roster_positions: ["QB", "RB", "RB", "WR", "FLEX", "BN"], scoring_settings: { rec: 0.5, pass_td: 6 } } as unknown as SleeperLeague;

describe("buildLlmExport", () => {
  it("renders league, rankings, rosters and the pick list", () => {
    const review = reviewDraft([pick(1, 1, "p1"), pick(2, 2, "p3"), pick(3, 2, "p2")], [row("p1", "Alpha", 1, "RB"), row("p2", "Bravo", 2, "WR"), row("p3", "Charlie", 10, "RB")], players, [1, 2], (ids) => ids.length * 10);
    const md = buildLlmExport({ league, draft: null, mode: "redraft", myRosterId: 1, totalPicks: 12, review, teamName: (r) => `Team ${r}`, byeOf: (id) => (id === "p1" ? 6 : null), guideNames: ["PFF"] });
    expect(md).toContain("# Fantasy draft results — Test (2026)");
    expect(md).toContain("2×RB");
    expect(md).toContain("0.5 PPR, 6pt pass TD");
    expect(md).toContain("3 of 12 picks made");
    expect(md).toContain("**Team 2** — strength 20");
    expect(md).toContain("### Team 1 (me)");
    expect(md).toContain("RB Alpha — R1.01 (pick 1) · #1, Δ 0 · bye 6");
    expect(md).toContain("biggest reach Charlie (-8)");
    expect(md).toContain("2. Charlie (RB) → Team 2 · #10, Δ -8");
  });
});
