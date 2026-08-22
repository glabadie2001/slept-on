import { fetchJson } from "./http";
import { idbDelete, idbGet, idbSet } from "./idb";
import { mulberry32 } from "../lib/simulator";
import { isSuperflex } from "../lib/value";
import type { PlayerMap, SleeperLeague } from "../types";

/**
 * Real dynasty market values, three ways:
 *  - FantasyCalc live sync (public API; rows carry sleeperId → exact join,
 *    parameterized by superflex / PPR / league size)
 *  - paste import (KeepTradeCut-style "Name, 9999" lines — name-matched)
 *  - synthetic demo market for the offline demo league
 *
 * Raw market units differ per source (FC ~0-12000, KTC 0-9999); consumers
 * normalize via `maxValue`. Cached in IndexedDB per league.
 */

export interface MarketPick {
  season: string;
  round: number;
  value: number;
}

export interface MarketData {
  source: "fantasycalc" | "import" | "demo";
  label: string;
  fetchedAt: number;
  /** sleeper player_id -> raw market value */
  players: Record<string, number>;
  /** future pick values, averaged across early/mid/late tiers */
  picks: MarketPick[];
  /** normalization denominator (max player value) */
  maxValue: number;
  matched: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cacheKey = (leagueId: string) => `market_values:${leagueId}`;

export async function loadCachedMarket(leagueId: string): Promise<MarketData | null> {
  const cached = await idbGet<MarketData>(cacheKey(leagueId));
  if (!cached) return null;
  // Imports never expire (user-provided); synced sources go stale after the TTL.
  if (cached.source === "fantasycalc" && Date.now() - cached.fetchedAt > CACHE_TTL_MS) return null;
  return cached;
}

export async function saveMarket(leagueId: string, data: MarketData): Promise<void> {
  await idbSet(cacheKey(leagueId), data);
}

export async function clearMarketCache(leagueId: string): Promise<void> {
  await idbDelete(cacheKey(leagueId));
}

// ---------- FantasyCalc ----------

interface FantasyCalcRow {
  player?: {
    name?: string;
    sleeperId?: string | null;
    position?: string | null;
  } | null;
  value?: number;
}

/** "2027 1st", "2027 Early 2nd", "2027 Round 1" → { season, round } */
export function parsePickName(name: string): { season: string; round: number } | null {
  const m = /^(20\d{2})\s+(?:(?:early|mid|late)\s+)?(?:round\s+)?(\d+)(?:st|nd|rd|th)?$/i.exec(
    name.trim(),
  );
  if (!m) return null;
  const round = parseInt(m[2], 10);
  if (round < 1 || round > 7) return null;
  return { season: m[1], round };
}

function collectPicks(named: { name: string; value: number }[]): MarketPick[] {
  const byKey = new Map<string, { season: string; round: number; sum: number; n: number }>();
  for (const { name, value } of named) {
    const pick = parsePickName(name);
    if (!pick) continue;
    const key = `${pick.season}:${pick.round}`;
    const acc = byKey.get(key) ?? { ...pick, sum: 0, n: 0 };
    acc.sum += value;
    acc.n++;
    byKey.set(key, acc);
  }
  return [...byKey.values()].map((p) => ({
    season: p.season,
    round: p.round,
    value: Math.round(p.sum / p.n),
  }));
}

export function fantasyCalcParams(league: SleeperLeague): {
  numQbs: number;
  numTeams: number;
  ppr: number;
} {
  const rec = league.scoring_settings.rec ?? 0;
  return {
    numQbs: isSuperflex(league) ? 2 : 1,
    numTeams: league.total_rosters || 12,
    ppr: rec >= 0.75 ? 1 : rec >= 0.25 ? 0.5 : 0,
  };
}

export function parseFantasyCalcRows(rows: FantasyCalcRow[], label: string): MarketData {
  const players: Record<string, number> = {};
  const pickCandidates: { name: string; value: number }[] = [];
  for (const row of rows) {
    const value = row.value;
    if (typeof value !== "number" || !row.player) continue;
    const sleeperId = row.player.sleeperId;
    if (sleeperId) {
      players[String(sleeperId)] = value;
    } else if (row.player.name) {
      pickCandidates.push({ name: row.player.name, value });
    }
  }
  const maxValue = Math.max(1, ...Object.values(players));
  return {
    source: "fantasycalc",
    label,
    fetchedAt: Date.now(),
    players,
    picks: collectPicks(pickCandidates),
    maxValue,
    matched: Object.keys(players).length,
  };
}

export async function fetchFantasyCalc(league: SleeperLeague): Promise<MarketData> {
  const { numQbs, numTeams, ppr } = fantasyCalcParams(league);
  const url = `https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=${numQbs}&numTeams=${numTeams}&ppr=${ppr}&includeAdp=false`;
  const rows = await fetchJson<FantasyCalcRow[]>(url, { retries: 1, timeoutMs: 20_000 });
  if (!rows || rows.length === 0) throw new Error("FantasyCalc returned no data");
  const data = parseFantasyCalcRows(
    rows,
    `FantasyCalc (${numQbs === 2 ? "superflex" : "1QB"} · ${ppr} PPR · ${numTeams} tm)`,
  );
  if (data.matched === 0) throw new Error("FantasyCalc rows had no Sleeper ids");
  return data;
}

// ---------- Paste import (KeepTradeCut etc.) ----------

/** normalize a player name for matching: lowercase, strip punctuation + suffixes */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.'’,-]/g, "")
    .replace(/\s+(jr|sr|ii|iii|iv|v)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ImportLine {
  name: string;
  value: number;
}

/**
 * Parse pasted "one entry per line" text. Accepts:
 *   "Ja'Marr Chase, 9999"  ·  "Ja'Marr Chase\t9999"  ·  "12. Ja'Marr Chase 9999"
 *   "2027 1st, 4500"
 */
export function parseImportText(text: string): ImportLine[] {
  const out: ImportLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(?:\d{1,3}[.)]\s+)?(.+?)[,;\t ]+(\d{1,5}(?:\.\d+)?)$/.exec(line);
    if (!m) continue;
    const name = m[1].replace(/[,;]+$/, "").trim();
    const value = parseFloat(m[2]);
    if (!name || !(value > 0)) continue;
    out.push({ name, value });
  }
  return out;
}

export function buildImportMarket(
  lines: ImportLine[],
  players: PlayerMap,
): { data: MarketData; unmatched: string[] } {
  const byName = new Map<string, string>();
  for (const [id, p] of Object.entries(players)) {
    const name = p.full_name ?? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim();
    if (!name) continue;
    const key = normalizeName(name);
    // On collision prefer the more market-relevant player (lower search_rank).
    const prev = byName.get(key);
    if (prev == null || (p.search_rank ?? 1e9) < (players[prev]?.search_rank ?? 1e9)) {
      byName.set(key, id);
    }
  }

  const values: Record<string, number> = {};
  const pickCandidates: { name: string; value: number }[] = [];
  const unmatched: string[] = [];
  for (const { name, value } of lines) {
    if (parsePickName(name)) {
      pickCandidates.push({ name, value });
      continue;
    }
    const id = byName.get(normalizeName(name));
    if (id) values[id] = value;
    else unmatched.push(name);
  }

  const maxValue = Math.max(1, ...Object.values(values));
  return {
    data: {
      source: "import",
      label: "Manual import",
      fetchedAt: Date.now(),
      players: values,
      picks: collectPicks(pickCandidates),
      maxValue,
      matched: Object.keys(values).length,
    },
    unmatched,
  };
}

// ---------- Demo market (offline demo league) ----------

/**
 * Synthetic "market" for the demo league: heuristic values pushed through a
 * convex curve to market-like units, with seeded noise so market vs heuristic
 * disagree enough to make the blend slider visibly do something.
 */
export function buildDemoMarket(
  heuristicValues: Record<string, { value: number }>,
  currentSeason: string,
): MarketData {
  const rand = mulberry32(424242);
  const players: Record<string, number> = {};
  for (const [id, v] of Object.entries(heuristicValues)) {
    if (v.value < 2) continue; // markets don't list waiver fodder
    const noise = 0.7 + rand() * 0.6;
    players[id] = Math.round(Math.pow(v.value, 1.35) * 18 * noise);
  }
  const year = parseInt(currentSeason, 10);
  const picks: MarketPick[] = [];
  for (let y = 1; y <= 2; y++) {
    for (let round = 1; round <= 4; round++) {
      picks.push({
        season: String(year + y),
        round,
        value: Math.round(4800 / Math.pow(2.4, round - 1) / Math.pow(1.12, y - 1)),
      });
    }
  }
  return {
    source: "demo",
    label: "Demo market (synthetic)",
    fetchedAt: Date.now(),
    players,
    picks,
    maxValue: Math.max(1, ...Object.values(players)),
    matched: Object.keys(players).length,
  };
}
