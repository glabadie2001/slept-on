import { fetchJson } from "./http";
import { loadPlayersWithCache, trimPlayers } from "./playersCache";
import type {
  PlayerMap,
  ProjectionRow,
  SleeperDraft,
  SleeperDraftPick,
  SleeperLeague,
  SleeperMatchup,
  SleeperRoster,
  SleeperState,
  SleeperTradedPick,
  SleeperTransaction,
  SleeperUser,
  StatLine,
  TrendingPlayer,
} from "../types";

const V1 = "https://api.sleeper.app/v1";
// api.sleeper.com hosts the projections/stats endpoints used by Sleeper's own
// clients. Semi-official: everything that depends on it degrades gracefully.
const COM = "https://api.sleeper.com";

const SKILL_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"] as const;

export const sleeper = {
  getState: () => fetchJson<SleeperState>(`${V1}/state/nfl`),

  getUser: (usernameOrId: string) =>
    fetchJson<SleeperUser>(`${V1}/user/${encodeURIComponent(usernameOrId)}`),

  getUserLeagues: (userId: string, season: string) =>
    fetchJson<SleeperLeague[]>(`${V1}/user/${userId}/leagues/nfl/${season}`),

  getLeague: (leagueId: string) => fetchJson<SleeperLeague>(`${V1}/league/${leagueId}`),

  getRosters: (leagueId: string) => fetchJson<SleeperRoster[]>(`${V1}/league/${leagueId}/rosters`),

  getLeagueUsers: (leagueId: string) => fetchJson<SleeperUser[]>(`${V1}/league/${leagueId}/users`),

  getMatchups: (leagueId: string, week: number) =>
    fetchJson<SleeperMatchup[]>(`${V1}/league/${leagueId}/matchups/${week}`),

  getTradedPicks: (leagueId: string) =>
    fetchJson<SleeperTradedPick[]>(`${V1}/league/${leagueId}/traded_picks`),

  /** round = week for in-season transactions; Sleeper returns newest first. */
  getTransactions: (leagueId: string, round: number) =>
    fetchJson<SleeperTransaction[]>(`${V1}/league/${leagueId}/transactions/${round}`),

  /** newest first */
  getLeagueDrafts: (leagueId: string) =>
    fetchJson<SleeperDraft[]>(`${V1}/league/${leagueId}/drafts`),

  getDraft: (draftId: string) => fetchJson<SleeperDraft>(`${V1}/draft/${draftId}`),

  /** picks made so far, in pick order */
  getDraftPicks: (draftId: string) =>
    fetchJson<SleeperDraftPick[]>(`${V1}/draft/${draftId}/picks`),

  getTrending: (type: "add" | "drop", lookbackHours = 48, limit = 50) =>
    fetchJson<TrendingPlayer[]>(
      `${V1}/players/nfl/trending/${type}?lookback_hours=${lookbackHours}&limit=${limit}`,
    ),

  getPlayers: (): Promise<PlayerMap> =>
    loadPlayersWithCache(async () => {
      const raw = await fetchJson<Record<string, never>>(`${V1}/players/nfl`, {
        timeoutMs: 60_000,
        retries: 1,
      });
      if (!raw) throw new Error("players/nfl returned nothing");
      return trimPlayers(raw);
    }),

  /**
   * Weekly projections as raw stat lines (so league custom scoring can be applied).
   * Semi-official endpoint; returns [] on failure.
   */
  async getWeekProjections(season: string, week: number): Promise<ProjectionRow[]> {
    const pos = SKILL_POSITIONS.map((p) => `position[]=${p}`).join("&");
    try {
      const rows = await fetchJson<ProjectionRow[]>(
        `${COM}/projections/nfl/${season}/${week}?season_type=regular&${pos}&order_by=ppr`,
        { retries: 1 },
      );
      return rows ?? [];
    } catch {
      return [];
    }
  },

  /** Season stat totals for every player (used as baseline + projection fallback). */
  async getSeasonStats(season: string): Promise<Record<string, StatLine>> {
    // Preferred: api.sleeper.com rows. Fallback: legacy v1 map keyed by player id.
    const pos = SKILL_POSITIONS.map((p) => `position[]=${p}`).join("&");
    try {
      const rows = await fetchJson<ProjectionRow[]>(
        `${COM}/stats/nfl/${season}?season_type=regular&${pos}&order_by=pts_ppr`,
        { retries: 1 },
      );
      if (rows && rows.length > 0) {
        const out: Record<string, StatLine> = {};
        for (const r of rows) if (r.player_id && r.stats) out[r.player_id] = r.stats;
        return out;
      }
    } catch {
      /* fall through to legacy endpoint */
    }
    try {
      const legacy = await fetchJson<Record<string, StatLine>>(
        `${V1}/stats/nfl/regular/${season}`,
        { retries: 1, timeoutMs: 60_000 },
      );
      return legacy ?? {};
    } catch {
      return {};
    }
  },
};

export type SleeperApi = typeof sleeper;
