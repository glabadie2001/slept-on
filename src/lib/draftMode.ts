import type { BlendedValue } from "./market";
import type { SleeperDraft, SleeperLeague, SleeperRoster } from "../types";

/**
 * What kind of draft is this? The draft room's behavior forks on it:
 *
 *  - rookie   dynasty in-season rookie draft: rookies only, rostered players are
 *             off the board, dynasty value is the yardstick, positional need
 *             comes from existing rosters, 1QB "dead QB market" logic applies
 *  - startup  dynasty startup: the whole player pool, dynasty value, need is
 *             whatever each team has drafted so far
 *  - redraft  redraft / keeper season draft: whole pool, win-now value (age is
 *             irrelevant), K/DEF matter, need from picks so far
 *
 * Detection is a heuristic over Sleeper's league type + draft shape and can be
 * overridden per league in the UI (persisted in localStorage).
 */
export type DraftMode = "rookie" | "startup" | "redraft";

export const DRAFT_MODES: DraftMode[] = ["rookie", "startup", "redraft"];

export const DRAFT_MODE_LABEL: Record<DraftMode, string> = {
  rookie: "Rookie draft",
  startup: "Dynasty startup",
  redraft: "Redraft",
};

export const DRAFT_MODE_BLURB: Record<DraftMode, string> = {
  rookie: "Rookies only · rostered players hidden · dynasty value · needs from rosters",
  startup: "Full player pool · dynasty value · needs from picks made so far",
  redraft: "Full player pool · win-now value · K/DEF on the board · needs from picks made so far",
};

/** Sleeper league.settings.type: 0 redraft, 1 keeper, 2 dynasty */
export function isDynastyLeague(league: SleeperLeague): boolean {
  return league.settings.type === 2;
}

/** roster spots that get filled in a startup/redraft draft (BN yes, IR/TAXI no) */
export function draftableSlots(league: SleeperLeague): number {
  return league.roster_positions.filter((p) => p !== "IR" && p !== "TAXI").length;
}

export function detectDraftMode(
  league: SleeperLeague,
  rosters: SleeperRoster[],
  draft: SleeperDraft | null,
): DraftMode {
  if (!isDynastyLeague(league)) return "redraft";
  const rounds = draft?.settings.rounds ?? 0;
  // A dynasty draft long enough to fill most of a roster is a startup, as is
  // any draft when nobody has a roster yet.
  if (rounds >= Math.max(8, Math.floor(draftableSlots(league) * 0.6))) return "startup";
  const anyRostered = rosters.some((r) => (r.players?.length ?? 0) > 0);
  if (!anyRostered) return "startup";
  return "rookie";
}

/** sensible round count when Sleeper hasn't told us */
export function defaultRounds(mode: DraftMode, league: SleeperLeague, draft: SleeperDraft | null): number {
  if (draft?.settings.rounds) return draft.settings.rounds;
  if (mode === "rookie") return 4;
  return draftableSlots(league);
}

/** the number the board should rank by in this mode */
export function modeValue(mode: DraftMode, v: BlendedValue | undefined | null): number | null {
  if (!v) return null;
  return mode === "redraft" ? v.winNow : v.value;
}

export const MODE_VALUE_LABEL: Record<DraftMode, string> = {
  rookie: "Value",
  startup: "Value",
  redraft: "Win-now",
};

/** positions that belong on the board in this mode */
export function boardPositions(mode: DraftMode): string[] {
  return mode === "rookie" ? ["QB", "RB", "WR", "TE"] : ["QB", "RB", "WR", "TE", "K", "DEF"];
}

const MODE_KEY = (leagueId: string) => `draft_mode:${leagueId}`;

export function loadModeOverride(leagueId: string): DraftMode | null {
  try {
    const v = localStorage.getItem(MODE_KEY(leagueId));
    return v && (DRAFT_MODES as string[]).includes(v) ? (v as DraftMode) : null;
  } catch {
    return null;
  }
}

export function saveModeOverride(leagueId: string, mode: DraftMode | null): void {
  try {
    if (mode) localStorage.setItem(MODE_KEY(leagueId), mode);
    else localStorage.removeItem(MODE_KEY(leagueId));
  } catch {
    // non-fatal
  }
}
