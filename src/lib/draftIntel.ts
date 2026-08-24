import { positionalNeeds } from "./analysis";
import { isSuperflex } from "./value";
import type { ConsensusRow } from "./guides";
import type { BlendedValue } from "./market";
import type {
  PlayerMap,
  SleeperDraft,
  SleeperLeague,
  SleeperRoster,
  SleeperTradedPick,
} from "../types";

/**
 * Draft-day intelligence on top of the consensus board:
 *  - market divergence: where the synced market disagrees with your guides
 *  - pick ownership honoring traded picks → who picks between you and your next turn
 *  - survival odds: P(player lasts to your next pick), need-weighted
 *  - QB market context: in a 1QB league where every team is set, QBs have no buyer
 *
 * All transparent heuristics over data already in the LeagueBundle — same
 * philosophy as lib/value.ts: explainable, not a black box.
 */

// ---------- pick math ----------

/** overall pick number → round + slot (snake or linear) */
export function pickPosition(
  pickNo: number,
  teams: number,
  type: SleeperDraft["type"],
): { round: number; slot: number } {
  const round = Math.ceil(pickNo / teams);
  const idx = (pickNo - 1) % teams;
  const slot = type === "snake" && round % 2 === 0 ? teams - idx : idx + 1;
  return { round, slot };
}

/** roster_id on the clock for a given overall pick, honoring traded picks */
export function pickOwner(
  pickNo: number,
  draft: SleeperDraft,
  tradedPicks: SleeperTradedPick[],
): number | null {
  const teams = draft.settings.teams;
  if (!teams || !draft.slot_to_roster_id) return null;
  const { round, slot } = pickPosition(pickNo, teams, draft.type);
  const original = draft.slot_to_roster_id[String(slot)];
  if (original == null) return null;
  const trade = tradedPicks.find(
    (t) => t.season === draft.season && t.round === round && t.roster_id === original,
  );
  return trade ? trade.owner_id : original;
}

export interface UpcomingPicks {
  /** overall number of my next pick, or null if I have none left */
  myNextPick: number | null;
  /** roster_ids picking between now and my next pick, in order */
  interveningRosters: number[];
}

export function upcomingPicks(
  draft: SleeperDraft,
  tradedPicks: SleeperTradedPick[],
  picksMade: number,
  myRosterId: number,
): UpcomingPicks {
  const teams = draft.settings.teams ?? 0;
  const totalPicks = teams * (draft.settings.rounds ?? 0);
  const intervening: number[] = [];
  for (let pickNo = picksMade + 1; pickNo <= totalPicks; pickNo++) {
    const owner = pickOwner(pickNo, draft, tradedPicks);
    if (owner === myRosterId) return { myNextPick: pickNo, interveningRosters: intervening };
    if (owner != null) intervening.push(owner);
  }
  return { myNextPick: null, interveningRosters: [] };
}

// ---------- market divergence ----------

export interface Divergence {
  /** 1-based rank among board rows the market prices */
  marketRank: number;
  /** consensus − marketRank; positive = market likes them MORE than your guides */
  divergence: number;
}

export function marketDivergence(
  board: ConsensusRow[],
  values: Record<string, BlendedValue>,
): Map<string, Divergence> {
  const priced = board
    .filter((r) => r.sleeperId != null && values[r.sleeperId]?.market != null)
    .sort((a, b) => values[b.sleeperId!].market! - values[a.sleeperId!].market!);
  const out = new Map<string, Divergence>();
  priced.forEach((r, i) => {
    out.set(r.key, { marketRank: i + 1, divergence: r.consensus - (i + 1) });
  });
  return out;
}

// ---------- QB market context ----------

export interface QbContext {
  dead: boolean;
  /** teams whose QB room is already set long-term */
  setTeams: number;
  totalTeams: number;
  reason: string;
}

/**
 * In a 1QB league, a QB only has a buyer if some team lacks a long-term
 * starter. "Set" = rosters a QB aged ≤ 29 with dynasty value ≥ 45, or any QB
 * valued ≥ 65 (elite vets keep their seat regardless of age).
 */
export function qbMarketContext(
  league: SleeperLeague,
  rosters: SleeperRoster[],
  players: PlayerMap,
  values: Record<string, BlendedValue>,
): QbContext {
  const totalTeams = rosters.length;
  if (isSuperflex(league)) {
    return { dead: false, setTeams: 0, totalTeams, reason: "Superflex league — QBs always have a market." };
  }
  let setTeams = 0;
  for (const roster of rosters) {
    const set = (roster.players ?? []).some((id) => {
      const p = players[id];
      if (p?.position !== "QB") return false;
      const v = values[id]?.value ?? 0;
      return (v >= 45 && (p.age ?? 99) <= 29) || v >= 65;
    });
    if (set) setTeams++;
  }
  const dead = setTeams === totalTeams;
  return {
    dead,
    setTeams,
    totalTeams,
    reason: dead
      ? `1QB league and all ${totalTeams} teams already have a long-term starter — QBs have no buyer here.`
      : `1QB league; ${totalTeams - setTeams} team${totalTeams - setTeams === 1 ? "" : "s"} still need a QB.`,
  };
}

// ---------- positional need multipliers ----------

/**
 * Per-roster appetite for each position, from positionalNeeds quality vs the
 * league median: 1 = neutral, >1 = hungry, <1 = satisfied. QB appetite in a
 * dead 1QB market is floored near zero — set teams only stash, never reach.
 */
export function needMultipliers(
  league: SleeperLeague,
  rosters: SleeperRoster[],
  players: PlayerMap,
  values: Record<string, BlendedValue>,
  qb: QbContext,
): Map<number, Record<string, number>> {
  const perRoster = new Map<number, Record<string, number>>();
  const qualityByPos: Record<string, number[]> = {};
  const needsByRoster = new Map<number, Record<string, number>>();

  for (const roster of rosters) {
    const needs = positionalNeeds(league, roster, players, values);
    const q: Record<string, number> = {};
    for (const n of needs) {
      q[n.position] = n.quality;
      (qualityByPos[n.position] ??= []).push(n.quality);
    }
    needsByRoster.set(roster.roster_id, q);
  }

  const median: Record<string, number> = {};
  for (const [pos, qs] of Object.entries(qualityByPos)) {
    const sorted = [...qs].sort((a, b) => a - b);
    median[pos] = sorted[Math.floor(sorted.length / 2)];
  }

  for (const roster of rosters) {
    const q = needsByRoster.get(roster.roster_id) ?? {};
    const mult: Record<string, number> = {};
    for (const pos of Object.keys(median)) {
      const gap = median[pos] - (q[pos] ?? 0);
      mult[pos] = Math.min(1.8, Math.max(0.6, 1 + gap / 60));
    }
    if (qb.dead) mult.QB = 0.25;
    perRoster.set(roster.roster_id, mult);
  }
  return perRoster;
}

// ---------- survival odds ----------

/** how many of the top available players a drafter realistically considers */
const CONSIDERATION_SET = 10;
/** appetite decay down the board: weight ∝ exp(−index / TASTE_DECAY) */
const TASTE_DECAY = 3;

/**
 * P(row still available at your next pick). Each intervening team picks from
 * the top of the available board with exponentially decaying weights scaled by
 * its positional need. Independent approximation: the board is not re-shrunk
 * between simulated picks, so odds for top players are slightly optimistic —
 * fine for a "will he last?" signal, not a betting line.
 */
export function survivalOdds(
  availableBoard: ConsensusRow[],
  interveningRosters: number[],
  needs: Map<number, Record<string, number>>,
): Map<string, number> {
  const out = new Map<string, number>();
  const pool = availableBoard.slice(0, CONSIDERATION_SET + interveningRosters.length);
  for (const row of availableBoard) out.set(row.key, 1);

  for (const rosterId of interveningRosters) {
    const mult = needs.get(rosterId) ?? {};
    const weights = pool.map((row, i) => {
      const base = Math.exp(-i / TASTE_DECAY);
      const need = row.position ? (mult[row.position] ?? 1) : 1;
      return base * need;
    });
    const total = weights.reduce((s, w) => s + w, 0);
    if (total <= 0) continue;
    pool.forEach((row, i) => {
      const pTaken = weights[i] / total;
      out.set(row.key, (out.get(row.key) ?? 1) * (1 - pTaken));
    });
  }
  return out;
}
