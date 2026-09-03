import { describe, expect, it } from "vitest";
import { recommendPicks } from "./draftIntel";
import type { ConsensusRow } from "./guides";

const row = (name: string, consensus: number, position: string): ConsensusRow => ({
  key: name.toLowerCase(), displayName: name, sleeperId: null, position, ranks: {}, avg: consensus,
  best: consensus, worst: consensus, sd: 0, tier: null, count: 1, nEff: 1, consensus,
});

describe("recommendPicks", () => {
  const board = [row("A", 1, "RB"), row("B", 2, "WR"), row("C", 3, "RB"), row("D", 8, "WR"), row("E", 20, "TE")];
  it("takes the top of the board when everyone is about to go", () => {
    const surv = new Map(board.map((r) => [r.key, 0]));
    expect(recommendPicks(board, {}, surv)[0].row.displayName).toBe("A");
  });
  it("defers a player who will last when a scarce one won't", () => {
    // A lasts for sure, B is gone: B should lead
    const surv = new Map([["a", 1], ["b", 0], ["c", 0], ["d", 1], ["e", 1]]);
    const recs = recommendPicks(board, {}, surv);
    expect(recs[0].row.displayName).toBe("B");
  });
  it("bends toward positional need", () => {
    const surv = new Map(board.map((r) => [r.key, 0]));
    const recs = recommendPicks(board, { RB: 0.3, WR: 1.8 }, surv);
    expect(recs[0].row.displayName).toBe("B");
  });
  it("names a same-position fallback that likely lasts", () => {
    const surv = new Map([["a", 0.1], ["b", 0.1], ["c", 0.9], ["d", 0.9], ["e", 0.9]]);
    const a = recommendPicks(board, {}, surv).find((r) => r.row.displayName === "A")!;
    expect(a.fallback?.displayName).toBe("C");
  });
  it("works without survival odds", () => {
    expect(recommendPicks(board, {}, null)[0].score).toBe(100);
  });
});
