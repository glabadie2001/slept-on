import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { sleeper } from "./api/sleeper";
import {
  buildDemoMarket,
  buildImportMarket,
  clearMarketCache,
  fetchFantasyCalc,
  loadCachedMarket,
  parseImportText,
  saveMarket,
} from "./api/marketValues";
import type { MarketData } from "./api/marketValues";
import { buildDemoBundle } from "./demo/demoData";
import { scoreStatLine, seasonPpg } from "./lib/scoring";
import { computePlayerValues } from "./lib/value";
import { blendPlayerValues, blendedPickValue } from "./lib/market";
import type { BlendedValue } from "./lib/market";
import { buildTeams } from "./lib/analysis";
import { log } from "./lib/log";
import type { AppConfig } from "./store/config";
import type { LeagueBundle, SleeperMatchup, SleeperTradedPick, TeamInfo } from "./types";

export interface AppData {
  bundle: LeagueBundle;
  teams: TeamInfo[];
  myTeam: TeamInfo | null;
  /** dynasty values: heuristic blended with market values when synced */
  values: Record<string, BlendedValue>;
  /** projected points for the active week under league scoring (falls back to last-season PPG) */
  projPts: (playerId: string) => number;
  refresh: () => void;
  // --- market values ---
  market: MarketData | null;
  marketBlend: number;
  marketSyncing: boolean;
  marketError: string | null;
  setMarketBlend: (b: number) => void;
  syncMarket: () => Promise<void>;
  importMarket: (text: string) => { matched: number; total: number; unmatched: string[] };
  clearMarket: () => void;
  pickVal: (pick: SleeperTradedPick) => number;
}

const Ctx = createContext<AppData | null>(null);

export function useAppData(): AppData {
  const data = useContext(Ctx);
  if (!data) throw new Error("useAppData outside provider");
  return data;
}

const BLEND_KEY = "war-room-market-blend-v1";

function loadBlend(): number {
  try {
    const v = parseFloat(localStorage.getItem(BLEND_KEY) ?? "");
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.7;
  } catch {
    return 0.7;
  }
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

  // Full regular-season schedule (past scores + future pairings) for the
  // playoff simulator. Sleeper serves all weeks once the league schedule
  // exists; each miss just leaves that week empty (the simulator copes).
  const regularSeasonEnd = (league.settings.playoff_week_start ?? 15) - 1;
  const schedule: Record<number, SleeperMatchup[]> = {};
  if (league.status === "in_season" || league.status === "complete") {
    const weekNums = Array.from({ length: regularSeasonEnd }, (_, i) => i + 1);
    const perWeek = await Promise.all(
      weekNums.map((w) =>
        w === week && matchups && matchups.length > 0
          ? Promise.resolve(matchups)
          : sleeper.getMatchups(cfg.leagueId, w).catch(() => null),
      ),
    );
    weekNums.forEach((w, i) => {
      const m = perWeek[i];
      if (m && m.length > 0) schedule[w] = m;
    });
  }

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
    schedule,
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
  const [market, setMarket] = useState<MarketData | null>(null);
  const [marketBlend, setMarketBlendState] = useState(loadBlend);
  const [marketSyncing, setMarketSyncing] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (config.demo) {
      log.info("league", "Demo league loaded");
      setBundle(buildDemoBundle());
      return;
    }
    setBundle(null);
    const started = performance.now();
    loadRealBundle(config)
      .then((b) => {
        if (cancelled) return;
        log.info(
          "league",
          `Loaded ${b.league.name} (week ${b.week}) in ${Math.round(performance.now() - started)}ms`,
          `${b.rosters.length} rosters · ${Object.keys(b.players).length} players · ${b.transactions.length} recent transactions`,
        );
        setBundle(b);
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        log.error("league", `League load failed: ${msg}`);
        onError(msg);
      });
    return () => {
      cancelled = true;
    };
  }, [config, reloadKey, onError]);

  const leagueId = config.demo ? "demo" : config.leagueId;

  // Restore a previously synced/imported market for this league.
  useEffect(() => {
    let cancelled = false;
    loadCachedMarket(leagueId).then((m) => {
      if (!cancelled && m) setMarket(m);
    });
    return () => {
      cancelled = true;
    };
  }, [leagueId]);

  const refresh = useCallback(() => {
    log.info("ui", "Manual refresh");
    setReloadKey((k) => k + 1);
  }, []);

  const setMarketBlend = useCallback((b: number) => {
    const clamped = Math.min(1, Math.max(0, b));
    setMarketBlendState(clamped);
    try {
      localStorage.setItem(BLEND_KEY, String(clamped));
    } catch {
      // non-fatal
    }
  }, []);

  const heuristicValues = useMemo(() => {
    if (!bundle) return null;
    return computePlayerValues({
      players: bundle.players,
      league: bundle.league,
      lastSeasonStats: bundle.lastSeasonStats,
      projections: bundle.projections,
    });
  }, [bundle]);

  const syncMarket = useCallback(async () => {
    if (!bundle || !heuristicValues) return;
    setMarketSyncing(true);
    setMarketError(null);
    try {
      const data = bundle.demo
        ? buildDemoMarket(heuristicValues, bundle.league.season)
        : await fetchFantasyCalc(bundle.league);
      setMarket(data);
      await saveMarket(leagueId, data);
      log.info("market", `Market values synced (${data.source}) — ${data.matched} players matched`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("market", `Market sync failed: ${msg}`);
      setMarketError(msg);
    } finally {
      setMarketSyncing(false);
    }
  }, [bundle, heuristicValues, leagueId]);

  const importMarket = useCallback(
    (text: string) => {
      if (!bundle) return { matched: 0, total: 0, unmatched: [] };
      const lines = parseImportText(text);
      if (lines.length === 0) {
        throw new Error("No parsable lines — expected one entry per line like: Player Name, 9999");
      }
      const { data, unmatched } = buildImportMarket(lines, bundle.players);
      if (data.matched === 0) {
        throw new Error("Parsed the list but matched no player names to your league's player pool");
      }
      setMarket(data);
      setMarketError(null);
      void saveMarket(leagueId, data);
      return { matched: data.matched, total: lines.length, unmatched };
    },
    [bundle, leagueId],
  );

  const clearMarket = useCallback(() => {
    setMarket(null);
    setMarketError(null);
    void clearMarketCache(leagueId);
  }, [leagueId]);

  const data = useMemo<AppData | null>(() => {
    if (!bundle || !heuristicValues) return null;
    const values = blendPlayerValues(heuristicValues, market, marketBlend);
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
    const pickVal = (pick: SleeperTradedPick) =>
      blendedPickValue(pick, bundle.league.season, market, marketBlend);
    return {
      bundle,
      teams,
      myTeam,
      values,
      projPts,
      refresh,
      market,
      marketBlend,
      marketSyncing,
      marketError,
      setMarketBlend,
      syncMarket,
      importMarket,
      clearMarket,
      pickVal,
    };
  }, [
    bundle,
    heuristicValues,
    market,
    marketBlend,
    marketSyncing,
    marketError,
    refresh,
    setMarketBlend,
    syncMarket,
    importMarket,
    clearMarket,
  ]);

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
