import { describe, expect, it } from "vitest";
import { reviewDraft } from "./draftReview";
import type { ConsensusRow } from "./guides";
import type { PlayerMap, SleeperDraftPick } from "../types";

const row = (id: string, name: string, consensus: number, position: string): ConsensusRow => ({
  key: name.toLowerCase(), displayName: name, sleeperId: id, position, ranks: {}, avg: consensus,
  best: consensus, worst: consensus, sd: 0, tier: null, count: 1, nEff: 1, consensus,
});
const pick = (pick_no: number, roster_id: number, player_id: string): SleeperDraftPick => ({
  round: Math.ceil(pick_no / 2), pick_no, draft_slot: ((pick_no - 1) % 2) + 1, roster_id, player_id, picked_by: "u",
});
const players = { p1: { full_name: "Alpha", position: "RB" }, p2: { full_name: "Bravo", position: "WR" }, p3: { full_name: "Charlie", position: "RB" }, p4: { full_name: "Delta", position: "QB" } } as unknown as PlayerMap;
const board = [row("p1", "Alpha", 1, "RB"), row("p2", "Bravo", 2, "WR"), row("p3", "Charlie", 10, "RB"), row("p4", "Delta", 3, "QB")];

describe("reviewDraft", () => {
  const picks = [pick(1, 1, "p1"), pick(2, 2, "p3"), pick(3, 2, "p2"), pick(4, 1, "p4")];
  const review = reviewDraft(picks, board, players, [1, 2], (ids) => ids.length * 10);

  it("scores value vs reach against consensus", () => {
    const charlie = review.picks.find((p) => p.name === "Charlie")!;
    expect(charlie.delta).toBe(-8); // #10 taken 2nd: reach
    const bravo = review.picks.find((p) => p.name === "Bravo")!;
    expect(bravo.delta).toBe(1); // #2 taken 3rd: value
    expect(review.biggestReaches[0].name).toBe("Charlie");
    expect(review.bestValues[0].name).toBe("Bravo");
  });
  it("ranks teams by roster strength and tracks per-team extremes", () => {
    expect(review.teams.map((t) => t.rosterId)).toEqual([1, 2]);
    expect(review.teams[1].biggestReach?.name).toBe("Charlie");
    expect(review.teams[1].posMix).toEqual({ RB: 1, WR: 1 });
    expect(review.teams[0].avgDelta).toBe(0.5); // (0 + 1) / 2
  });
  it("leaves unranked picks out of the deltas but in the haul", () => {
    const r = reviewDraft([pick(1, 1, "zzz")], board, players, [1], () => 0);
    expect(r.picks[0].delta).toBeNull();
    expect(r.coverage).toBe(0);
    expect(r.teams[0].picks).toHaveLength(1);
  });
});
