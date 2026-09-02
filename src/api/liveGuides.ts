import { fetchJson } from "./http";
import { fantasyCalcParams } from "./marketValues";
import type { DraftMode } from "../lib/draftMode";
import type { GuideEntry } from "../lib/guides";
import { isSuperflex } from "../lib/value";
import type { PlayerMap, SleeperLeague } from "../types";

/**
 * Live draft guides: public ranking feeds fetched straight from the browser and
 * turned into Guide entries, so the consensus board has fresh sources on day
 * one without anyone pasting anything. Each source is best-effort — a blocked
 * or reshaped feed just means that guide doesn't load (the UI says so).
 *
 *  - FantasyCalc: trade-value rankings (dynasty or redraft, parameterized by
 *    superflex / PPR / league size). Rows carry sleeperId → exact name match.
 *  - Fantasy Football Calculator: real mock-draft ADP (redraft only), by
 *    scoring format; 2QB boards for superflex leagues.
 */

export interface LiveGuideSource {
  id: string;
  name: string;
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
    const name = sleeperName(players, r.player!.sleeperId) ?? r.player!.name;
    if (!name) continue;
    out.push({ name, rank: out.length + 1, tier: null, position: pos });
    if (out.length >= max) break;
  }
  return out;
}

export const fantasyCalcSource: LiveGuideSource = {
  id: "fantasycalc",
  name: "FantasyCalc rankings",
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

// ---------- Fantasy Football Calculator ADP ----------

interface FfcResponse {
  players?: { name?: string; position?: string; team?: string; adp?: number }[];
}

/** FFC team codes that differ from Sleeper's DEF player ids */
const FFC_TEAM_TO_SLEEPER: Record<string, string> = { JAC: "JAX", LA: "LAR", WSH: "WAS" };

export function ffcFormat(league: SleeperLeague): string {
  if (isSuperflex(league)) return "2qb";
  const { ppr } = fantasyCalcParams(league);
  return ppr >= 1 ? "ppr" : ppr >= 0.5 ? "half-ppr" : "standard";
}

export function ffcGuideName(league: SleeperLeague): string {
  return `FFCalculator ADP (${ffcFormat(league)} · ${league.total_rosters || 12} tm) — live`;
}

export function ffcRowsToEntries(res: FfcResponse, players: PlayerMap): GuideEntry[] {
  const rows = (res.players ?? [])
    .filter((p) => p.name && typeof p.adp === "number")
    .sort((a, b) => a.adp! - b.adp!);
  return rows.map((p, i) => {
    let pos = (p.position ?? "").toUpperCase() || null;
    if (pos === "PK") pos = "K";
    if (pos === "DST") pos = "DEF";
    let name = p.name!;
    if (pos === "DEF" && p.team) {
      const id = FFC_TEAM_TO_SLEEPER[p.team.toUpperCase()] ?? p.team.toUpperCase();
      name = sleeperName(players, id) ?? name;
    }
    return { name, rank: i + 1, tier: null, position: pos };
  });
}

export const ffcAdpSource: LiveGuideSource = {
  id: "ffc-adp",
  name: "FFCalculator ADP",
  modes: ["redraft"],
  async fetch(league, players) {
    const teams = league.total_rosters || 12;
    const url = `https://fantasyfootballcalculator.com/api/v1/adp/${ffcFormat(league)}?teams=${teams}&year=${league.season}&position=all`;
    const res = await fetchJson<FfcResponse>(url, { retries: 1, timeoutMs: 20_000 });
    if (!res?.players?.length) throw new Error("FFCalculator returned no ADP rows");
    return ffcRowsToEntries(res, players);
  },
};

export const LIVE_SOURCES: LiveGuideSource[] = [fantasyCalcSource, ffcAdpSource];

export function liveSourcesFor(mode: DraftMode): LiveGuideSource[] {
  return LIVE_SOURCES.filter((s) => s.modes.includes(mode));
}

export function liveGuideName(source: LiveGuideSource, league: SleeperLeague, mode: DraftMode): string {
  return source.id === "fantasycalc" ? fantasyCalcGuideName(league, mode) : ffcGuideName(league);
}
