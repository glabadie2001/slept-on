import { mulberry32 } from "../lib/simulator";
import type { Guide } from "../lib/guides";
import type { PlayerMap } from "../types";

/**
 * Sample draft guides for the demo league: three fictional analysts ranking
 * the incoming rookie class (unrostered, no NFL team yet) with seeded
 * disagreement, and a couple of names no analyst can agree exist (to demo
 * unmatched-row handling). Deep enough to mock the full 4-round demo draft.
 */
export function buildSampleGuides(players: PlayerMap): Guide[] {
  const pool = Object.values(players)
    .filter((p) => (p.years_exp ?? 99) === 0 && !p.team && p.position !== "K" && p.position !== "DEF")
    .sort((a, b) => (a.search_rank ?? 1e9) - (b.search_rank ?? 1e9))
    .slice(0, 52);

  const sources = [
    { name: "The Dynasty Ledger — Rookie & Sophomore Guide", seed: 11, jitter: 4, drops: 3 },
    { name: "Grid & Grind Draft Manual", seed: 23, jitter: 8, drops: 6 },
    { name: "Coach Amari's Big Board", seed: 37, jitter: 12, drops: 0 },
  ];

  const guides = sources.map((src, gi) => {
    const rand = mulberry32(src.seed);
    const ranked = pool
      .map((p, i) => ({ p, score: i + (rand() - 0.5) * src.jitter }))
      .sort((a, b) => a.score - b.score)
      .filter((_, i) => i >= pool.length - src.drops ? false : true)
      .map(({ p }, i) => ({
        name: p.full_name ?? p.player_id,
        rank: i + 1,
        tier: i < 4 ? 1 : i < 12 ? 2 : i < 24 ? 3 : 4,
        position: p.position ?? null,
      }));
    return {
      id: `sample-${gi}`,
      name: src.name,
      addedAt: Date.now() - gi,
      entries: ranked,
      source: "sample" as const,
    };
  });

  // One guide hypes two prospects nobody else has heard of.
  guides[1].entries.splice(5, 0, { name: "Dax Thunderwood", rank: 6, tier: 2, position: "RB" });
  guides[1].entries.splice(14, 0, { name: "Bo Jackson-Reyes", rank: 15, tier: 3, position: "WR" });
  guides[1].entries.forEach((e, i) => (e.rank = i + 1));

  return guides;
}
