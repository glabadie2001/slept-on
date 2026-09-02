import { fetchJson } from "./http";
import { fantasyCalcParams } from "./marketValues";
import type { DraftMode } from "../lib/draftMode";
import type { GuideEntry, GuideKind } from "../lib/guides";
import { sleeperProjectionEntries } from "../lib/projections";
import { isSuperflex } from "../lib/value";
import type { PlayerMap, ProjectionRow, SleeperLeague } from "../types";

/**
 * Live draft guides: public ranking feeds fetched straight from the browser and
 * turned into Guide entries, so the consensus board has fresh sources on day
 * one without anyone pasting anything. Each source is best-effort — a blocked
 * or reshaped feed just means that guide doesn't load (the UI says so).
 *
 *  - FantasyCalc: trade-value rankings (dynasty or redraft, parameterized by
 *    superflex / PPR / league size). Rows carry sleeperId → exact name match.
 *  - Sleeper ADP: the platform's own draft ADP (redraft by scoring format,
 *    2QB for superflex, dynasty/rookie variants), from api.sleeper.com.
 */

export interface LiveGuideSource {
  id: string;
  name: string;
  /** what the feed measures — decides which board (value / availability) it joins */
  kind: GuideKind;
  /** which draft modes this source makes sense for */
  modes: DraftMode[];
  fetch: (league: SleeperLeague, players: PlayerMap, mode: DraftMode) => Promise<GuideEntry[]>;
}

const sleeperName = (players: PlayerMap, id: string | null | undefined): string | null => {
  if (!id) return null;
  const p = players[id];
  if (!p) return null;
  return p.full_name ?? (`${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || null);
};

// ---------- FantasyCalc ----------

interface FcRow {
  player?: { name?: string; sleeperId?: string | null; position?: string | null } | null;
  value?: number;
  overallRank?: number;
}

export function fantasyCalcGuideName(league: SleeperLeague, mode: DraftMode): string {
  const { numQbs, ppr } = fantasyCalcParams(league);
  return `FantasyCalc ${mode === "redraft" ? "Redraft" : "Dynasty"} (${numQbs === 2 ? "SF" : "1QB"} · ${ppr} PPR) — live`;
}

export function fantasyCalcRowsToEntries(rows: FcRow[], players: PlayerMap, max = 300): GuideEntry[] {
  const ranked = rows
    .filter((r) => r.player && typeof r.value === "number")
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const out: GuideEntry[] = [];
  for (const r of ranked) {
    const pos = r.player!.position?.toUpperCase() ?? null;
    // picks ("2027 1st") and anything without a position aren't players
    if (!pos || /^\d{4}/.test(r.player!.name ?? "")) continue;
    const sid = r.player!.sleeperId ? String(r.player!.sleeperId) : null;
    const name = sleeperName(players, sid) ?? r.player!.name;
    if (!name) continue;
    out.push({ name, rank: out.length + 1, tier: null, position: pos, sleeperId: sid && players[sid] ? sid : null });
    if (out.length >= max) break;
  }
  return out;
}

export const fantasyCalcSource: LiveGuideSource = {
  id: "fantasycalc",
  name: "FantasyCalc rankings",
  kind: "market",
  modes: ["rookie", "startup", "redraft"],
  async fetch(league, players, mode) {
    const { numQbs, numTeams, ppr } = fantasyCalcParams(league);
    const url = `https://api.fantasycalc.com/values/current?isDynasty=${mode !== "redraft"}&numQbs=${numQbs}&numTeams=${numTeams}&ppr=${ppr}&includeAdp=false`;
    const rows = await fetchJson<FcRow[]>(url, { retries: 1, timeoutMs: 20_000 });
    if (!rows || rows.length === 0) throw new Error("FantasyCalc returned no data");
    const entries = fantasyCalcRowsToEntries(rows, players);
    if (entries.length === 0) throw new Error("FantasyCalc rows had no players");
    return entries;
  },
};

// ---------- Sleeper ADP ----------

/**
 * Sleeper's own draft ADP rides along on the season projections rows at
 * api.sleeper.com (the host the app already uses for projections/stats), as
 * stats.adp_* keyed by format. Rows are keyed by Sleeper player_id → exact
 * matches, including team defenses.
 */
interface SleeperAdpRow {
  player_id?: string;
  stats?: Record<string, number | null | undefined> | null;
}

/** preferred ADP stat keys for a league + mode, most specific first */
export function sleeperAdpKeys(league: SleeperLeague, mode: DraftMode): string[] {
  const sf = isSuperflex(league);
  const { ppr } = fantasyCalcParams(league);
  const scoring = ppr >= 1 ? "ppr" : ppr >= 0.5 ? "half_ppr" : "std";
  if (mode === "rookie") return ["adp_rookie", sf ? "adp_dynasty_2qb" : `adp_dynasty_${scoring}`, "adp_dynasty"];
  if (mode === "startup") {
    return sf
      ? ["adp_dynasty_2qb", "adp_dynasty", `adp_dynasty_${scoring}`]
      : [`adp_dynasty_${scoring}`, "adp_dynasty", "adp_dynasty_2qb"];
  }
  return sf ? ["adp_2qb", `adp_${scoring}`, "adp_ppr"] : [`adp_${scoring}`, "adp_ppr", "adp_half_ppr", "adp_std"];
}

export function sleeperAdpGuideName(league: SleeperLeague, mode: DraftMode): string {
  return `Sleeper ADP (${sleeperAdpKeys(league, mode)[0].replace(/^adp_/, "").replace(/_/g, " ")}) — live`;
}

/** rows → ranked entries using the first ADP key that enough rows actually carry */
export function sleeperAdpRowsToEntries(
  rows: SleeperAdpRow[],
  players: PlayerMap,
  keys: string[],
  minRows = 20,
): { entries: GuideEntry[]; key: string | null } {
  for (const key of keys) {
    const ranked = rows
      .filter((r) => r.player_id && typeof r.stats?.[key] === "number" && (r.stats[key] as number) > 0)
      .sort((a, b) => (a.stats![key] as number) - (b.stats![key] as number));
    if (ranked.length < minRows) continue;
    const entries: GuideEntry[] = [];
    for (const r of ranked) {
      const name = sleeperName(players, r.player_id);
      if (!name) continue;
      entries.push({
        name,
        rank: entries.length + 1,
        tier: null,
        position: players[r.player_id!]?.position ?? null,
        sleeperId: r.player_id!,
      });
    }
    return { entries, key };
  }
  return { entries: [], key: null };
}

export const sleeperAdpSource: LiveGuideSource = {
  id: "sleeper-adp",
  name: "Sleeper ADP",
  kind: "adp",
  modes: ["rookie", "startup", "redraft"],
  async fetch(league, players, mode) {
    const keys = sleeperAdpKeys(league, mode);
    const pos = ["QB", "RB", "WR", "TE", "K", "DEF"].map((p) => `position[]=${p}`).join("&");
    const url = `https://api.sleeper.com/projections/nfl/${league.season}?season_type=regular&${pos}&order_by=${keys[0]}`;
    const rows = await fetchJson<SleeperAdpRow[]>(url, { retries: 1, timeoutMs: 30_000 });
    if (!rows || rows.length === 0) throw new Error("Sleeper projections returned no rows");
    const { entries, key } = sleeperAdpRowsToEntries(rows, players, keys);
    if (!key) throw new Error(`Sleeper rows carry no ${keys.join("/")} ADP yet for ${league.season}`);
    return entries;
  },
};

// ---------- Sleeper season projections, scored with the league's rules ----------

export function sleeperProjectionGuideName(league: SleeperLeague): string {
  const { ppr } = fantasyCalcParams(league);
  return `Sleeper ${league.season} projections (${ppr} PPR · league scoring) — live`;
}

export const sleeperProjectionSource: LiveGuideSource = {
  id: "sleeper-proj",
  name: "Sleeper projections",
  kind: "projection",
  modes: ["startup", "redraft"],
  async fetch(league, players) {
    const pos = ["QB", "RB", "WR", "TE", "K", "DEF"].map((p) => `position[]=${p}`).join("&");
    const url = `https://api.sleeper.com/projections/nfl/${league.season}?season_type=regular&${pos}&order_by=adp_half_ppr`;
    const rows = await fetchJson<ProjectionRow[]>(url, { retries: 1, timeoutMs: 30_000 });
    if (!rows || rows.length === 0) throw new Error("Sleeper projections returned no rows");
    const entries = sleeperProjectionEntries(rows, league.scoring_settings, players);
    if (entries.length < 50) throw new Error(`Sleeper projections scored only ${entries.length} players under this league's rules`);
    return entries;
  },
};

export const LIVE_SOURCES: LiveGuideSource[] = [fantasyCalcSource, sleeperAdpSource, sleeperProjectionSource];

export function liveSourcesFor(mode: DraftMode): LiveGuideSource[] {
  return LIVE_SOURCES.filter((s) => s.modes.includes(mode));
}

export function liveGuideName(source: LiveGuideSource, league: SleeperLeague, mode: DraftMode): string {
  switch (source.id) {
    case "fantasycalc":
      return fantasyCalcGuideName(league, mode);
    case "sleeper-proj":
      return sleeperProjectionGuideName(league);
    default:
      return sleeperAdpGuideName(league, mode);
  }
}
