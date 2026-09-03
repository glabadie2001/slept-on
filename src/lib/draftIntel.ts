import { positionalNeeds } from "./analysis";
import { SLOT_ELIGIBILITY, startingSlots } from "./lineup";
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
 *  - pick-based needs for startup/redraft drafts, where rosters are empty and
 *    appetite is "what has this team drafted so far vs the lineup it must fill"
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
export const CONSIDERATION_SET = 10;
/** appetite decay down the board: weight ∝ exp(−index / TASTE_DECAY) */
export const TASTE_DECAY = 3;

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

// ---------- pick-based need multipliers (startup / redraft) ----------

const BOARD_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];

/** how flex slots spread demand across positions */
const FLEX_SHARE: Record<string, Record<string, number>> = {
  FLEX: { RB: 0.45, WR: 0.45, TE: 0.1 },
  WRRB_FLEX: { RB: 0.5, WR: 0.5 },
  REC_FLEX: { WR: 0.7, TE: 0.3 },
  SUPER_FLEX: { QB: 0.6, RB: 0.15, WR: 0.2, TE: 0.05 },
};

export interface PositionTargets {
  /** dedicated starting slots per position (integers) */
  strict: Record<string, number>;
  /** dedicated slots + this position's share of flex slots */
  starters: Record<string, number>;
  /** starters + a bench allowance — the roster a sane drafter ends up with */
  targets: Record<string, number>;
  startingSlots: number;
}

export function positionTargets(league: SleeperLeague, rounds: number): PositionTargets {
  const strict: Record<string, number> = {};
  const starters: Record<string, number> = {};
  const slots = startingSlots(league);
  for (const slot of slots) {
    const elig = SLOT_ELIGIBILITY[slot];
    if (elig.length === 1) {
      strict[elig[0]] = (strict[elig[0]] ?? 0) + 1;
      starters[elig[0]] = (starters[elig[0]] ?? 0) + 1;
    } else {
      for (const [pos, share] of Object.entries(FLEX_SHARE[slot] ?? {})) {
        starters[pos] = (starters[pos] ?? 0) + share;
      }
    }
  }
  const bench = Math.max(0, rounds - slots.length);
  const sf = isSuperflex(league);
  const benchShare: Record<string, number> = { QB: sf ? 0.16 : 0.08, RB: 0.38, WR: 0.38, TE: 0.08, K: 0, DEF: 0 };
  const targets: Record<string, number> = {};
  for (const pos of BOARD_POSITIONS) {
    targets[pos] = (starters[pos] ?? 0) + bench * (benchShare[pos] ?? 0);
  }
  return { strict, starters, targets, startingSlots: slots.length };
}

/**
 * Per-roster appetite by position from what each team has drafted so far.
 * Same 0.x–2.x scale as needMultipliers so survivalOdds/mocks can use either:
 *   missing a dedicated starter → hungry, more so as the draft gets late
 *   flex share / bench allowance unfilled → neutral-ish
 *   position full → cold (a 4th RB in a 1QB league is a luxury)
 *   K/DEF → ignored until the closing rounds, then mandatory (≥ 2 = a
 *   "must fill" the mock engine will reach for)
 *   backup QB in 1QB → only worth a look past the midpoint
 */
export function pickNeedMultipliers(
  league: SleeperLeague,
  rounds: number,
  round: number,
  draftedPositions: Map<number, string[]>,
  rosterIds: number[],
): Map<number, Record<string, number>> {
  const t = positionTargets(league, rounds);
  const sf = isSuperflex(league);
  const progress = rounds > 0 ? Math.min(1, Math.max(0, (round - 1) / rounds)) : 0;
  const remaining = Math.max(1, rounds - round + 1);
  const out = new Map<number, Record<string, number>>();

  for (const rid of rosterIds) {
    const have: Record<string, number> = {};
    for (const pos of draftedPositions.get(rid) ?? []) have[pos] = (have[pos] ?? 0) + 1;
    const unfilledKD = Math.max(0, (t.strict.K ?? 0) - (have.K ?? 0)) + Math.max(0, (t.strict.DEF ?? 0) - (have.DEF ?? 0));
    const mult: Record<string, number> = {};
    for (const pos of BOARD_POSITIONS) {
      const n = have[pos] ?? 0;
      const strict = t.strict[pos] ?? 0;
      if (pos === "K" || pos === "DEF") {
        if (strict === 0 || n >= strict) mult[pos] = 0.02;
        else if (remaining <= unfilledKD) mult[pos] = 50; // out of rounds: must
        else if (remaining === unfilledKD + 1) mult[pos] = 4; // one round of slack: should
        else mult[pos] = progress > 0.75 ? 0.6 : 0.05;
        continue;
      }
      let m: number;
      if (n < strict) m = 1.4 + progress * 1.2;
      else if (n < Math.ceil(t.starters[pos] ?? 0)) m = 1.1;
      else if (n < (t.targets[pos] ?? 0)) m = 0.85;
      else m = 0.3;
      if (pos === "QB" && !sf && n >= 1) m = n >= 2 ? 0.01 : progress < 0.55 ? 0.15 : 0.5;
      if (pos === "QB" && sf && n >= 2) m = n >= 3 ? 0.05 : 0.45;
      if (pos === "TE" && n >= 1 && m > 0.4) m = n >= 2 ? 0.05 : 0.35;
      mult[pos] = m;
    }
    out.set(rid, mult);
  }
  return out;
}

/** positions drafted so far per roster, from live Sleeper picks */
export function draftedPositionsFromPicks(
  picks: { roster_id: number | null; player_id: string; metadata?: { position?: string } | null }[],
  players: PlayerMap,
): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const p of picks) {
    if (p.roster_id == null) continue;
    const pos = players[p.player_id]?.position ?? p.metadata?.position;
    if (!pos) continue;
    (out.get(p.roster_id) ?? out.set(p.roster_id, []).get(p.roster_id)!).push(pos);
  }
  return out;
}

// ---------- recommended picks ----------

export interface Recommendation {
  row: ConsensusRow;
  /** 0-100 composite */
  score: number;
  /** rank-derived worth, 0-100 */
  worth: number;
  /** my positional appetite (1 = neutral) */
  need: number;
  /** P(still there at my next pick), null when I have no pick left */
  survival: number | null;
  /** best available at the same position who probably lasts to my next pick, if the pick can wait */
  fallback: ConsensusRow | null;
  /** his bye week, when known */
  bye: number | null;
  /** my already-drafted players who share that bye and compete for the same lineup slots */
  byeClashes: string[];
}

export interface MyDrafted {
  name: string;
  position: string | null;
  bye: number | null;
}

const FLEX_GROUP = new Set(["RB", "WR", "TE"]);
/** score multiplier per same-position bye clash / per flex-group clash */
const BYE_SAME = 0.86;
const BYE_FLEX = 0.96;

export interface ByeContext {
  /** bye week of a board row (null = unknown) */
  of: (row: ConsensusRow) => number | null;
  /** what I have drafted so far */
  mine: MyDrafted[];
}

/** bye-stacking penalty for adding `row` to what I already have: [multiplier, clashing names] */
export function byePenalty(row: ConsensusRow, bye: number | null, mine: MyDrafted[]): [number, string[]] {
  if (bye == null || !row.position) return [1, []];
  let mult = 1;
  const names: string[] = [];
  for (const m of mine) {
    if (m.bye !== bye || !m.position) continue;
    if (m.position === row.position) {
      mult *= BYE_SAME;
      names.push(m.name);
    } else if (FLEX_GROUP.has(m.position) && FLEX_GROUP.has(row.position)) {
      mult *= BYE_FLEX;
      names.push(m.name);
    }
  }
  return [Math.max(0.6, mult), names];
}

/** consensus rank → worth on a 0-100 curve (steep at the top, long flat tail) */
export const rankWorth = (consensus: number): number => 100 * Math.exp(-(consensus - 1) / 45);

/**
 * What to take now. Worth from consensus rank, bent by my positional need, by
 * urgency — a player who will still be there at my next pick can wait, so his
 * "take now" score is discounted toward the value of the best same-position
 * player who is likely to last — and by bye stacking with what I've already
 * drafted (same position hurts, a shared flex pool hurts a little).
 * Scores are relative (top = 100).
 */
export function recommendPicks(
  available: ConsensusRow[],
  myNeed: Record<string, number>,
  survival: Map<string, number> | null,
  { limit = 5, pool = 40, lastsThreshold = 0.6, byes = null as ByeContext | null } = {},
): Recommendation[] {
  const cands = available.slice(0, pool);
  const lastsByPos = new Map<string, ConsensusRow>();
  if (survival) {
    for (const r of cands) {
      if (!r.position || lastsByPos.has(r.position)) continue;
      if ((survival.get(r.key) ?? 1) >= lastsThreshold) lastsByPos.set(r.position, r);
    }
  }
  const recs: Recommendation[] = cands.map((row) => {
    const worth = rankWorth(row.consensus);
    const need = row.position ? (myNeed[row.position] ?? 1) : 1;
    const p = survival ? (survival.get(row.key) ?? 1) : null;
    const fb = row.position ? (lastsByPos.get(row.position) ?? null) : null;
    // if he lasts, taking him now only beats waiting by what I'd lose vs the fallback
    let takeNow = worth;
    if (p != null && fb && fb.key !== row.key) {
      const fbWorth = rankWorth(fb.consensus);
      takeNow = worth * (1 - p) + p * Math.max(fbWorth, worth * 0.5);
    } else if (p != null && fb && fb.key === row.key) {
      // he IS the fallback: he can wait, unless nothing else is worth taking
      takeNow = worth * (1 - p * 0.35);
    }
    const bye = byes ? byes.of(row) : null;
    const [byeMult, byeClashes] = byes ? byePenalty(row, bye, byes.mine) : [1, []];
    return { row, score: takeNow * need * byeMult, worth, need, survival: p, fallback: fb && fb.key !== row.key ? fb : null, bye, byeClashes };
  });
  recs.sort((a, b) => b.score - a.score);
  const top = recs[0]?.score || 1;
  return recs.slice(0, limit).map((r) => ({ ...r, score: Math.round((r.score / top) * 100) }));
}
