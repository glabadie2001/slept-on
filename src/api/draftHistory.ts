import { idbGet, idbSet } from "./idb";
import { sleeper } from "./sleeper";
import { isRookieDraft } from "../lib/draftHistory";
import type { HistoricalDraft } from "../lib/draftHistory";
import { draftableSlots } from "../lib/draftMode";
import { sleeperAdpKeys } from "./liveGuides";
import type { SleeperLeague } from "../types";

/**
 * Walk previous_league_id back from the current league and collect every
 * completed draft's picks. Redraft leagues chain one league_id per season;
 * dynasty leagues chain too, with one (rookie) draft per season. Sleeper ADP
 * for each past season rides along when the projections endpoint still serves
 * it, so "reach vs ADP" can be measured. Cached per league for a day.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SEASONS = 6;
const cacheKey = (leagueId: string) => `draft_history:${leagueId}`;

export interface DraftHistoryBundle {
  fetchedAt: number;
  drafts: HistoricalDraft[];
  /** league ids walked, newest first */
  chain: string[];
}

export async function loadCachedHistory(leagueId: string): Promise<DraftHistoryBundle | null> {
  const c = await idbGet<DraftHistoryBundle>(cacheKey(leagueId));
  if (!c || Date.now() - c.fetchedAt > CACHE_TTL_MS) return null;
  return c;
}

async function seasonAdp(league: SleeperLeague, season: string): Promise<Record<string, number> | null> {
  const keys = sleeperAdpKeys(league, "redraft");
  const rows = await sleeper.getSeasonProjections(season, keys[0]);
  for (const key of keys) {
    const out: Record<string, number> = {};
    for (const r of rows) {
      const v = r.stats?.[key];
      if (r.player_id && typeof v === "number" && v > 0) out[r.player_id] = v;
    }
    if (Object.keys(out).length >= 50) return out;
  }
  return null;
}

export async function fetchDraftHistory(
  league: SleeperLeague,
  onProgress?: (msg: string) => void,
): Promise<DraftHistoryBundle> {
  const drafts: HistoricalDraft[] = [];
  const chain: string[] = [];
  const slots = draftableSlots(league);
  let cur: SleeperLeague | null = league;
  for (let i = 0; cur && i < MAX_SEASONS; i++) {
    chain.push(cur.league_id);
    onProgress?.(`${cur.season}: fetching drafts…`);
    const list = (await sleeper.getLeagueDrafts(cur.league_id)) ?? [];
    for (const d of list) {
      if (d.status !== "complete") continue;
      const picks = (await sleeper.getDraftPicks(d.draft_id)) ?? [];
      if (picks.length === 0) continue;
      const rounds = d.settings.rounds ?? Math.max(...picks.map((p) => p.round));
      const teams = d.settings.teams ?? Math.max(...picks.map((p) => p.draft_slot));
      drafts.push({
        season: d.season,
        draftId: d.draft_id,
        type: d.type,
        rounds,
        teams,
        rookieDraft: isRookieDraft({ rounds }, slots),
        picks,
        adp: null,
      });
    }
    cur = cur.previous_league_id ? await sleeper.getLeague(cur.previous_league_id) : null;
  }
  // ADP per season (one fetch per distinct season) — best effort
  const seasons = [...new Set(drafts.map((d) => d.season))];
  for (const season of seasons) {
    onProgress?.(`${season}: fetching Sleeper ADP…`);
    const adp = await seasonAdp(league, season).catch(() => null);
    for (const d of drafts) if (d.season === season) d.adp = adp;
  }
  const bundle: DraftHistoryBundle = { fetchedAt: Date.now(), drafts, chain };
  await idbSet(cacheKey(league.league_id), bundle);
  return bundle;
}
