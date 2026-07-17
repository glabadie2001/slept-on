import type { PlayerMap, SleeperLeague } from "../types";

/**
 * Lineup optimizer: assigns roster players to the league's actual starting slots
 * (QB/RB/WR/TE/K/DEF/FLEX/SUPER_FLEX/REC_FLEX/WRRB_FLEX/IDP variants ignored)
 * to maximize total projected points.
 *
 * Strategy: fill strictest slots first (fewest eligible positions), best player
 * first. With flex slots processed last this greedy is optimal in practice for
 * fantasy-sized rosters, and it is deterministic and explainable.
 */

export const SLOT_ELIGIBILITY: Record<string, string[]> = {
  QB: ["QB"],
  RB: ["RB"],
  WR: ["WR"],
  TE: ["TE"],
  K: ["K"],
  DEF: ["DEF"],
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["WR", "RB"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
};

const IGNORED_SLOTS = new Set(["BN", "IR", "TAXI"]);

export interface LineupSlot {
  slot: string; // e.g. "RB", "FLEX"
  playerId: string | null;
  projected: number;
}

export interface LineupResult {
  slots: LineupSlot[];
  totalProjected: number;
  /** players who project better than a current starter at an eligible slot */
  benchAlerts: { benchId: string; overId: string; slot: string; gain: number }[];
}

export function startingSlots(league: SleeperLeague): string[] {
  return league.roster_positions.filter((p) => !IGNORED_SLOTS.has(p) && SLOT_ELIGIBILITY[p]);
}

function eligible(players: PlayerMap, playerId: string, slot: string): boolean {
  const p = players[playerId];
  if (!p) return false;
  const allowed = SLOT_ELIGIBILITY[slot] ?? [];
  const positions = p.fantasy_positions ?? (p.position ? [p.position] : []);
  return positions.some((pos) => allowed.includes(pos));
}

export interface OptimizeOptions {
  /** exclude players ruled out (Out/IR/Sus) from the optimal lineup */
  excludeUnavailable?: boolean;
}

const UNAVAILABLE = new Set(["Out", "IR", "PUP", "Sus", "COV", "DNR", "NA"]);

export function isUnavailable(players: PlayerMap, playerId: string): boolean {
  const st = players[playerId]?.injury_status;
  return st != null && UNAVAILABLE.has(st);
}

export function optimizeLineup(
  league: SleeperLeague,
  rosterPlayerIds: string[],
  players: PlayerMap,
  projectedPts: (playerId: string) => number,
  opts: OptimizeOptions = {},
): LineupResult {
  const slots = startingSlots(league);
  // Strictest slots first; stable order otherwise.
  const ordered = slots
    .map((slot, i) => ({ slot, i, strictness: SLOT_ELIGIBILITY[slot].length }))
    .sort((a, b) => a.strictness - b.strictness || a.i - b.i);

  const pool = rosterPlayerIds.filter(
    (id) => players[id] && !(opts.excludeUnavailable && isUnavailable(players, id)),
  );
  const used = new Set<string>();
  const filled: Record<number, LineupSlot> = {};

  for (const { slot, i } of ordered) {
    let best: string | null = null;
    let bestPts = -1;
    for (const id of pool) {
      if (used.has(id) || !eligible(players, id, slot)) continue;
      const pts = projectedPts(id);
      if (pts > bestPts) {
        bestPts = pts;
        best = id;
      }
    }
    if (best) used.add(best);
    filled[i] = { slot, playerId: best, projected: best ? Math.max(0, bestPts) : 0 };
  }

  const resultSlots = slots.map((_, i) => filled[i]);
  const totalProjected = resultSlots.reduce((s, r) => s + r.projected, 0);
  return { slots: resultSlots, totalProjected: Math.round(totalProjected * 10) / 10, benchAlerts: [] };
}

/**
 * Compare the currently-set starters against the optimal lineup and produce
 * concrete "start X over Y" advice.
 */
export function lineupAdvice(
  league: SleeperLeague,
  currentStarters: (string | null)[],
  rosterPlayerIds: string[],
  players: PlayerMap,
  projectedPts: (playerId: string) => number,
): { optimal: LineupResult; moves: { inId: string; outId: string | null; slot: string; gain: number }[]; currentProjected: number } {
  const optimal = optimizeLineup(league, rosterPlayerIds, players, projectedPts, {
    excludeUnavailable: true,
  });
  const slots = startingSlots(league);
  const current = currentStarters.filter((s): s is string => !!s && s !== "0");
  const currentSet = new Set(current);
  // A ruled-out starter scores 0 in reality, so count them as 0 here — otherwise
  // the "current" projection can beat the optimal (which excludes them).
  const currentProjected = current.reduce(
    (s, id) => s + (isUnavailable(players, id) ? 0 : projectedPts(id)),
    0,
  );

  const moves: { inId: string; outId: string | null; slot: string; gain: number }[] = [];
  for (let i = 0; i < optimal.slots.length; i++) {
    const opt = optimal.slots[i];
    if (!opt.playerId) continue;
    if (!currentSet.has(opt.playerId)) {
      const outId = currentStarters[i] && currentStarters[i] !== "0" ? currentStarters[i] : null;
      const outPts = outId ? projectedPts(outId) : 0;
      moves.push({
        inId: opt.playerId,
        outId,
        slot: slots[i] ?? opt.slot,
        gain: Math.round((opt.projected - outPts) * 10) / 10,
      });
    }
  }
  return { optimal, moves, currentProjected: Math.round(currentProjected * 10) / 10 };
}
