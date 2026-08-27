import type { PlayerMap, SleeperRoster, StatLine, TrendingPlayer } from "../types";
import { scoreStatLine, seasonPpg } from "./scoring";

// ---------- Waiver Watchdog ----------
//
// Sniffs out breakout candidates among free agents *before* the market fully
// catches up — the "next Puka" problem. A breakout leaves footprints in the
// weekly stat lines (points spike over the player's own baseline, opportunity
// climbing week over week) well before season-long averages or dynasty values
// move. This module reads recently completed weeks' raw stat lines for every
// NFL player and flags unrostered players whose footprints match.

export type WatchdogTier = "breakout" | "watch";

export interface WatchdogAlert {
  playerId: string;
  tier: WatchdogTier;
  score: number;
  /** points in the most recent completed week the player has a stat line for */
  lastWeekPts: number;
  /** the week that stat line came from */
  lastWeek: number;
  /** the player's own baseline: avg of earlier recent weeks, else last-season PPG */
  baselinePpg: number;
  /** consecutive weeks (ending at lastWeek) with strictly rising opportunity */
  usageStreak: number;
  /** opportunity (targets + carries + pass attempts) in lastWeek */
  lastUsage: number;
  trendCount: number;
  signals: string[];
}

/** Opportunity proxy from a raw weekly line: targets + carries + pass attempts.
 *  Targets fall back to receptions when the feed omits `rec_tgt`. */
export function usageOf(line: StatLine | undefined): number {
  if (!line) return 0;
  const targets = line.rec_tgt ?? line.tgt ?? line.rec ?? 0;
  return targets + (line.rush_att ?? 0) + (line.pass_att ?? 0);
}

const WATCHDOG_POSITIONS = new Set(["QB", "RB", "WR", "TE"]);

// Thresholds, in league-scoring points. BREAKOUT_* gates the loud tier; a
// player must both put up a startable week and clearly beat his own baseline.
const BREAKOUT_PTS = 12;
const BREAKOUT_RATIO = 1.6;
const WATCH_MIN_SCORE = 14;

export function waiverWatchdog(
  rosters: SleeperRoster[],
  players: PlayerMap,
  recentStats: Record<number, Record<string, StatLine>>,
  scoring: Record<string, number>,
  trendingAdds: TrendingPlayer[],
  lastSeasonStats: Record<string, StatLine>,
  limit = 12,
): WatchdogAlert[] {
  const weeks = Object.keys(recentStats)
    .map(Number)
    .sort((a, b) => a - b);
  if (weeks.length === 0) return [];

  const rostered = new Set<string>();
  for (const r of rosters) for (const id of r.players ?? []) rostered.add(id);
  const trendMap = new Map(trendingAdds.map((t) => [t.player_id, t.count]));
  const maxTrend = Math.max(1, ...trendingAdds.map((t) => t.count));

  const alerts: WatchdogAlert[] = [];
  for (const [id, p] of Object.entries(players)) {
    if (rostered.has(id) || !p.team) continue;
    if (!p.position || !WATCHDOG_POSITIONS.has(p.position)) continue;

    // Weekly (week, pts, usage) rows for the weeks this player actually has a
    // line — a bye/DNP week is absence of evidence, not a zero-point game.
    const rows = weeks
      .map((w) => ({ week: w, line: recentStats[w][id] }))
      .filter((r) => r.line)
      .map((r) => ({ week: r.week, pts: scoreStatLine(r.line!, scoring), usage: usageOf(r.line) }));
    if (rows.length === 0) continue;

    const latest = rows[rows.length - 1];
    // A breakout has to be *fresh*: skip players whose last line is stale.
    if (latest.week < weeks[weeks.length - 1] - 1) continue;

    const prior = rows.slice(0, -1);
    const baselinePpg =
      prior.length > 0
        ? prior.reduce((s, r) => s + r.pts, 0) / prior.length
        : seasonPpg(lastSeasonStats[id], scoring);
    // Ratio floor keeps a 4-pt week over a 1-pt baseline from reading as a 4x spike.
    const spikeRatio = latest.pts / Math.max(3, baselinePpg);

    let usageStreak = 0;
    for (let i = rows.length - 1; i > 0; i--) {
      if (rows[i].usage > rows[i - 1].usage) usageStreak++;
      else break;
    }

    const trend = trendMap.get(id) ?? 0;
    const young = (p.years_exp ?? 99) <= 2;

    const score =
      1.5 * latest.pts +
      2 * Math.max(0, latest.pts - baselinePpg) +
      4 * usageStreak +
      25 * (trend / maxTrend) +
      (young ? 8 : 0);
    if (score < WATCH_MIN_SCORE) continue;

    const isBreakout =
      latest.pts >= BREAKOUT_PTS &&
      spikeRatio >= BREAKOUT_RATIO &&
      (usageStreak >= 2 || trend >= maxTrend * 0.3);

    const signals: string[] = [];
    signals.push(
      `${latest.pts.toFixed(1)} pts in wk ${latest.week}` +
        (baselinePpg > 0 ? ` vs ${baselinePpg.toFixed(1)} avg before` : " out of nowhere"),
    );
    if (usageStreak >= 2)
      signals.push(`opportunity up ${usageStreak} straight weeks (${latest.usage} touches+targets)`);
    if (trend > 0) signals.push(`${trend.toLocaleString()} adds in 48h`);
    if (young)
      signals.push(
        `${p.years_exp === 0 ? "rookie" : p.years_exp === 1 ? "2nd-year" : "3rd-year"} ${p.position} — classic breakout profile`,
      );

    alerts.push({
      playerId: id,
      tier: isBreakout ? "breakout" : "watch",
      score: Math.round(score * 10) / 10,
      lastWeekPts: latest.pts,
      lastWeek: latest.week,
      baselinePpg: Math.round(baselinePpg * 10) / 10,
      usageStreak,
      lastUsage: Math.round(latest.usage),
      trendCount: trend,
      signals,
    });
  }

  return alerts
    .sort(
      (a, b) =>
        Number(b.tier === "breakout") - Number(a.tier === "breakout") || b.score - a.score,
    )
    .slice(0, limit);
}
