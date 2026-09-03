// Review of the *real* Sleeper draft (in progress or complete): every pick
// scored against the consensus board (value vs reach), every team's haul
// scored the way the mock scores a timeline (projected starter points in a
// season draft, summed dynasty value in a rookie draft), and league-wide
// best values / biggest reaches.
import { normalizeName } from "../api/marketValues";
import { rankWorth } from "./draftIntel";
import type { ConsensusRow } from "./guides";
import type { PlayerMap, SleeperDraftPick } from "../types";

export interface ReviewPick {
  pickNo: number;
  round: number;
  slot: number;
  rosterId: number | null;
  playerId: string;
  name: string;
  position: string | null;
  /** consensus rank on your board, null when unranked */
  consensus: number | null;
  /** pick number − consensus rank: positive = fell to you (value), negative = reach */
  delta: number | null;
  keeper: boolean;
}

export interface TeamReview {
  rosterId: number;
  picks: ReviewPick[];
  /** roster strength: projected starter points (season) or summed dynasty value (rookie) */
  strength: number;
  /** summed consensus worth of ranked picks, 0-100 each */
  worth: number;
  /** mean delta over ranked picks */
  avgDelta: number | null;
  posMix: Record<string, number>;
  bestValue: ReviewPick | null;
  biggestReach: ReviewPick | null;
}

export interface DraftReview {
  teams: TeamReview[];
  picks: ReviewPick[];
  bestValues: ReviewPick[];
  biggestReaches: ReviewPick[];
  /** share of picks your board had ranked at all */
  coverage: number;
}

export function reviewDraft(
  picks: SleeperDraftPick[],
  board: ConsensusRow[],
  players: PlayerMap,
  rosterIds: number[],
  scoreRoster: (playerIds: string[]) => number,
  { top = 5 } = {},
): DraftReview {
  const byId = new Map<string, ConsensusRow>();
  const byKey = new Map<string, ConsensusRow>();
  for (const r of board) {
    if (r.sleeperId && !byId.has(r.sleeperId)) byId.set(r.sleeperId, r);
    if (!byKey.has(r.key)) byKey.set(r.key, r);
  }
  const reviewed: ReviewPick[] = picks.map((p) => {
    const pl = players[p.player_id];
    const name = (pl?.full_name ?? `${p.metadata?.first_name ?? ""} ${p.metadata?.last_name ?? ""}`.trim()) || p.player_id;
    const row = byId.get(p.player_id) ?? byKey.get(normalizeName(name)) ?? null;
    const consensus = row?.consensus ?? null;
    return {
      pickNo: p.pick_no,
      round: p.round,
      slot: p.draft_slot,
      rosterId: p.roster_id,
      playerId: p.player_id,
      name,
      position: pl?.position ?? p.metadata?.position ?? row?.position ?? null,
      consensus,
      delta: consensus == null ? null : p.pick_no - consensus,
      keeper: !!p.is_keeper,
    };
  });

  const teams: TeamReview[] = rosterIds.map((rid) => {
    const mine = reviewed.filter((r) => r.rosterId === rid);
    const ranked = mine.filter((r): r is ReviewPick & { delta: number; consensus: number } => r.delta != null && !r.keeper);
    const posMix: Record<string, number> = {};
    for (const r of mine) if (r.position) posMix[r.position] = (posMix[r.position] ?? 0) + 1;
    const bestValue = ranked.reduce<ReviewPick | null>((b, r) => (r.delta > 0 && (!b || r.delta > (b.delta ?? 0)) ? r : b), null);
    const biggestReach = ranked.reduce<ReviewPick | null>((b, r) => (r.delta < 0 && (!b || r.delta < (b.delta ?? 0)) ? r : b), null);
    return {
      rosterId: rid,
      picks: mine,
      strength: mine.length ? scoreRoster(mine.map((r) => r.playerId)) : 0,
      worth: Math.round(ranked.reduce((s, r) => s + rankWorth(r.consensus), 0)),
      avgDelta: ranked.length ? ranked.reduce((s, r) => s + r.delta, 0) / ranked.length : null,
      posMix,
      bestValue,
      biggestReach,
    };
  });
  teams.sort((a, b) => b.strength - a.strength || b.worth - a.worth);

  const scored = reviewed.filter((r) => r.delta != null && !r.keeper);
  const bestValues = [...scored].sort((a, b) => b.delta! - a.delta!).filter((r) => r.delta! > 0).slice(0, top);
  const biggestReaches = [...scored].sort((a, b) => a.delta! - b.delta!).filter((r) => r.delta! < 0).slice(0, top);
  return { teams, picks: reviewed, bestValues, biggestReaches, coverage: reviewed.length ? scored.length / reviewed.length : 0 };
}
