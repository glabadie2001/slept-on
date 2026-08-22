import type { MarketData } from "../api/marketValues";
import type { PlayerValue } from "./value";
import { pickValue } from "./value";
import type { SleeperTradedPick } from "../types";

/**
 * Blend market values into the heuristic on the heuristic's 0-100 scale.
 * `blend` is the weight on the market side (0 = heuristic only, 1 = market only).
 * Players the market doesn't list keep their pure heuristic value — the market
 * simply doesn't price deep-bench guys, that's not a signal they're worthless.
 */

export interface BlendedValue extends PlayerValue {
  /** raw market value in source units (e.g. FantasyCalc ~0-12000), if listed */
  market: number | null;
  /** market value normalized to the 0-100 scale, if listed */
  marketNorm: number | null;
}

export function normalizeMarket(raw: number, market: MarketData): number {
  return Math.min(100, (100 * raw) / market.maxValue);
}

export function blendPlayerValues(
  heuristic: Record<string, PlayerValue>,
  market: MarketData | null,
  blend: number,
): Record<string, BlendedValue> {
  const out: Record<string, BlendedValue> = {};
  const w = Math.min(1, Math.max(0, blend));
  for (const [id, h] of Object.entries(heuristic)) {
    const raw = market?.players[id];
    if (market && raw != null) {
      const norm = normalizeMarket(raw, market);
      out[id] = {
        ...h,
        value: Math.round(((1 - w) * h.value + w * norm) * 10) / 10,
        market: raw,
        marketNorm: Math.round(norm * 10) / 10,
      };
    } else {
      out[id] = { ...h, market: null, marketNorm: null };
    }
  }
  return out;
}

/** Market-aware pick value on the 0-100 scale; falls back to the heuristic. */
export function blendedPickValue(
  pick: SleeperTradedPick,
  currentSeason: string,
  market: MarketData | null,
  blend: number,
): number {
  const heur = pickValue(pick, currentSeason);
  const entry = market?.picks.find((p) => p.season === pick.season && p.round === pick.round);
  if (!market || !entry) return heur;
  const w = Math.min(1, Math.max(0, blend));
  const norm = normalizeMarket(entry.value, market);
  return Math.round(((1 - w) * heur + w * norm) * 10) / 10;
}
