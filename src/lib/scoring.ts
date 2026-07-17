import type { StatLine } from "../types";

/**
 * Score a raw stat line with the league's scoring_settings.
 * Sleeper uses identical stat keys in both (pass_yd, rush_td, rec, bonus_rec_te, ...),
 * so league-custom scoring — TE premium, superflex, first downs, whatever — is exact.
 */
export function scoreStatLine(stats: StatLine, scoring: Record<string, number>): number {
  let pts = 0;
  for (const [key, value] of Object.entries(stats)) {
    const weight = scoring[key];
    if (weight && typeof value === "number") pts += weight * value;
  }
  return Math.round(pts * 100) / 100;
}

/** Games played from a season stat line (gp, or gms_active as fallback). */
export function gamesPlayed(stats: StatLine | undefined): number {
  if (!stats) return 0;
  return stats.gp ?? stats.gms_active ?? 0;
}

/** Points per game from a season stat line under league scoring. */
export function seasonPpg(stats: StatLine | undefined, scoring: Record<string, number>): number {
  const gp = gamesPlayed(stats);
  if (!stats || gp === 0) return 0;
  return Math.round((scoreStatLine(stats, scoring) / gp) * 100) / 100;
}
