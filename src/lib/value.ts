import type { PlayerMap, SleeperLeague, SleeperTradedPick, StatLine } from "../types";
import { seasonPpg } from "./scoring";
import { projectionPpg } from "./projections";

/**
 * Dynasty value model (transparent heuristic, 0–100 scale).
 *
 * value = production score (PPG vs positional replacement, normalized)
 *       × age multiplier (position-specific career curve)
 *       + youth upside bonus (draft-capital proxy via Sleeper search_rank for
 *         young players with little/no production yet)
 *
 * It is intentionally simple and explainable — every number shown in the UI can
 * be traced to production, age, and market interest. It is NOT a market price
 * (KeepTradeCut-style); use it to rank and sanity-check, not as gospel.
 */

export interface PlayerValue {
  playerId: string;
  value: number; // 0-100 dynasty value
  winNow: number; // 0-100 pure production score (redraft-ish)
  ppg: number;
  ageMult: number;
}

// Age curves: [peakStart, peakEnd, declinePerYear, cliffAge]
const AGE_CURVES: Record<string, { peakStart: number; peakEnd: number; decline: number; cliff: number }> = {
  QB: { peakStart: 24, peakEnd: 33, decline: 0.06, cliff: 38 },
  RB: { peakStart: 22, peakEnd: 25, decline: 0.16, cliff: 30 },
  WR: { peakStart: 23, peakEnd: 28, decline: 0.1, cliff: 32 },
  TE: { peakStart: 24, peakEnd: 29, decline: 0.1, cliff: 33 },
  K: { peakStart: 23, peakEnd: 35, decline: 0.03, cliff: 42 },
  DEF: { peakStart: 0, peakEnd: 99, decline: 0, cliff: 99 },
};

// Rough replacement-level PPG per position in a 12-team league (half-PPR-ish
// scale; only used to normalize, so exact scoring barely moves rankings).
const REPLACEMENT_PPG: Record<string, number> = {
  QB: 14,
  RB: 7,
  WR: 7,
  TE: 5,
  K: 6,
  DEF: 5,
};

// Positional scarcity weight for dynasty (how much surplus production is worth).
const POSITION_WEIGHT: Record<string, number> = {
  QB: 0.9, // bumped to 1.15 automatically in superflex leagues
  RB: 1.0,
  WR: 1.05,
  TE: 1.0,
  K: 0.25,
  DEF: 0.3,
};

export function ageMultiplier(position: string, age: number | null | undefined): number {
  const curve = AGE_CURVES[position] ?? AGE_CURVES.WR;
  if (age == null || age <= 0) return 1;
  if (age >= curve.cliff) return 0.15;
  if (age > curve.peakEnd) {
    return Math.max(0.2, 1 - (age - curve.peakEnd) * curve.decline);
  }
  if (age < curve.peakStart) {
    // Younger than peak = slight premium in dynasty (more years of peak left).
    return Math.min(1.15, 1 + (curve.peakStart - age) * 0.04);
  }
  return 1;
}

export function isSuperflex(league: SleeperLeague): boolean {
  return league.roster_positions.some((p) => p === "SUPER_FLEX") ||
    league.roster_positions.filter((p) => p === "QB").length > 1;
}

export interface ValueModelInputs {
  players: PlayerMap;
  league: SleeperLeague;
  lastSeasonStats: Record<string, StatLine>;
  projections: Record<string, StatLine>;
  /** full-season stat projections; when present they lead the production estimate */
  seasonProjections?: Record<string, StatLine>;
}

/**
 * "Current production" PPG. A full-season projection (scored under league rules)
 * leads when we have one — it already prices in role changes, injuries and
 * rookies — blended with last season's actuals; otherwise last season blended
 * with this week's projection.
 */
function productionPpg(
  playerId: string,
  inputs: ValueModelInputs,
): number {
  const scoring = inputs.league.scoring_settings;
  const last = seasonPpg(inputs.lastSeasonStats[playerId], scoring);
  const season = projectionPpg(inputs.seasonProjections?.[playerId], scoring);
  if (season > 0) return last > 0 ? 0.65 * season + 0.35 * last : season;
  const projStats = inputs.projections[playerId];
  let proj = 0;
  if (projStats) {
    let pts = 0;
    for (const [k, v] of Object.entries(projStats)) {
      const w = scoring[k];
      if (w && typeof v === "number") pts += w * v;
    }
    proj = pts;
  }
  if (last > 0 && proj > 0) return 0.55 * last + 0.45 * proj;
  return Math.max(last, proj);
}

export function computePlayerValues(inputs: ValueModelInputs): Record<string, PlayerValue> {
  const superflex = isSuperflex(inputs.league);
  const out: Record<string, PlayerValue> = {};

  for (const [id, p] of Object.entries(inputs.players)) {
    const pos = p.position ?? "WR";
    const ppg = productionPpg(id, inputs);
    const replacement = REPLACEMENT_PPG[pos] ?? 7;
    const surplus = Math.max(0, ppg - replacement * 0.6);
    const posWeight = pos === "QB" && superflex ? 1.15 : (POSITION_WEIGHT[pos] ?? 1);

    // Production score: ~0-60 for surplus production over soft replacement.
    const winNowRaw = Math.min(60, surplus * 3.2) * posWeight;

    const mult = ageMultiplier(pos, p.age);

    // Youth upside: young + market-relevant (search_rank) but unproven.
    let upside = 0;
    const rank = p.search_rank ?? 9_999_999;
    const exp = p.years_exp ?? 99;
    if (p.age != null && p.age <= 25 && exp <= 3 && rank < 400 && pos !== "K" && pos !== "DEF") {
      upside = Math.max(0, ((400 - rank) / 400) * 28) * (superflex && pos === "QB" ? 1.2 : 1);
    }

    const value = Math.min(100, winNowRaw * mult + upside);
    out[id] = {
      playerId: id,
      value: Math.round(value * 10) / 10,
      winNow: Math.round(Math.min(100, winNowRaw * 1.4) * 10) / 10,
      ppg: Math.round(ppg * 10) / 10,
      ageMult: Math.round(mult * 100) / 100,
    };
  }
  return out;
}

/** Heuristic value of a future draft pick on the same 0-100 scale. */
export function pickValue(pick: SleeperTradedPick, currentSeason: string): number {
  const base: Record<number, number> = { 1: 55, 2: 28, 3: 12, 4: 5, 5: 3 };
  const b = base[pick.round] ?? 2;
  const yearsOut = Math.max(0, parseInt(pick.season, 10) - parseInt(currentSeason, 10));
  // Future picks trade at a discount (~10%/yr).
  return Math.round(b * Math.pow(0.9, yearsOut) * 10) / 10;
}

export function pickLabel(pick: SleeperTradedPick): string {
  const ord = ["", "1st", "2nd", "3rd", "4th", "5th", "6th", "7th"][pick.round] ?? `R${pick.round}`;
  return `${pick.season} ${ord}`;
}
