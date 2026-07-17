import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { sleeper } from "./api/sleeper";
import { buildDemoBundle } from "./demo/demoData";
import { scoreStatLine, seasonPpg } from "./lib/scoring";
import { computePlayerValues } from "./lib/value";
import type { PlayerValue } from "./lib/value";
import { buildTeams } from "./lib/analysis";
import type { AppConfig } from "./store/config";
import type { LeagueBundle, TeamInfo } from "./types";

export interface AppData {
  bundle: LeagueBundle;
  teams: TeamInfo[];
  myTeam: TeamInfo | null;
  values: Record<string, PlayerValue>;
  /** projected points for the active week under league scoring (falls back to last-season PPG) */
  projPts: (playerId: string) => number;
  refresh: () => void;
}

const Ctx = createContext<AppData | null>(null);

export function useAppData(): AppData {
  const data = useContext(Ctx);
  if (!data) throw new Error("useAppData outside provider");
  return data;
}

async function loadRealBundle(cfg: AppConfig): Promise<LeagueBundle> {
  const state = await sleeper.getState();
  if (!state) throw new Error("Could not reach Sleeper (state/nfl)");

  const league = await sleeper.getLeague(cfg.leagueId);
  if (!league) throw new Error(`League ${cfg.leagueId} not found`);

  const isOffseason = state.season_type === "off" || state.season_type === "pre" || league.status !== "in_season";
  // During the season, league.settings.leg is the league's current week.
  const week = Math.max(1, league.settings.leg ?? state.display_week ?? state.week ?? 1);
  const lastSeasonYear =
    league.status === "complete" ? league.season : state.previous_season || String(Number(state.season) - 1);

  const [users, rosters, players, matchups, tradedPicks, trendingAdds, trendingDrops, projRows, lastSeasonStats] =
    await Promise.all([
      sleeper.getLeagueUsers(cfg.leagueId),
      sleeper.getRosters(cfg.leagueId),
      sleeper.getPlayers(),
      isOffseason ? Promise.resolve([]) : sleeper.getMatchups(cfg.leagueId, week),
      sleeper.getTradedPicks(cfg.leagueId),
      sleeper.getTrending("add"),
      sleeper.getTrending("drop"),
      isOffseason ? Promise.resolve([]) : sleeper.getWeekProjections(league.season, week),
      sleeper.getSeasonStats(lastSeasonYear),
    ]);

  if (!users || !rosters) throw new Error("League users/rosters unavailable");

  // Recent transactions: current week plus the two before it (or week 1 in offseason).
  const txWeeks = isOffseason ? [1] : [week, week - 1, week - 2].filter((w) => w >= 1);
  const txArrays = await Promise.all(txWeeks.map((w) => sleeper.getTransactions(cfg.leagueId, w).catch(() => null)));
  const transactions = txArrays.flatMap((a) => a ?? []);

  const projections: Record<string, Record<string, number>> = {};
  for (const row of projRows) {
    if (row.player_id && row.stats) projections[row.player_id] = row.stats;
  }

  return {
    state,
    league,
    users,
    rosters,
    players,
    myUserId: cfg.userId,
    projections,
    lastSeasonStats,
    lastSeasonYear,
    matchups: matchups ?? [],
    transactions,
    tradedPicks: tradedPicks ?? [],
    trendingAdds: trendingAdds ?? [],
    trendingDrops: trendingDrops ?? [],
    week,
    isOffseason,
    demo: false,
  };
}

export function AppDataProvider({
  config,
  children,
  onError,
}: {
  config: AppConfig;
  children: ReactNode;
  onError: (message: string) => void;
}) {
  const [bundle, setBundle] = useState<LeagueBundle | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (config.demo) {
      setBundle(buildDemoBundle());
      return;
    }
    setBundle(null);
    loadRealBundle(config)
      .then((b) => !cancelled && setBundle(b))
      .catch((err) => !cancelled && onError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [config, reloadKey, onError]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  const data = useMemo<AppData | null>(() => {
    if (!bundle) return null;
    const values = computePlayerValues({
      players: bundle.players,
      league: bundle.league,
      lastSeasonStats: bundle.lastSeasonStats,
      projections: bundle.projections,
    });
    const teams = buildTeams(bundle.users, bundle.rosters, bundle.myUserId);
    const myTeam = teams.find((t) => t.isMine) ?? null;
    const scoring = bundle.league.scoring_settings;
    const projCache = new Map<string, number>();
    const projPts = (id: string): number => {
      let v = projCache.get(id);
      if (v == null) {
        const wk = bundle.projections[id];
        v = wk ? scoreStatLine(wk, scoring) : seasonPpg(bundle.lastSeasonStats[id], scoring);
        projCache.set(id, v);
      }
      return v;
    };
    return { bundle, teams, myTeam, values, projPts, refresh };
  }, [bundle, refresh]);

  if (!data) {
    return (
      <div className="loading-screen">
        <div className="loading-pulse">🏈</div>
        <p>Loading league data…</p>
        <p className="muted small">First load fetches the full NFL player database (~5 MB) — cached for 24h after.</p>
      </div>
    );
  }
  return <Ctx.Provider value={data}>{children}</Ctx.Provider>;
}
