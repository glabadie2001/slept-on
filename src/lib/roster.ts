import type { PlayerMap, SleeperLeague, SleeperRoster, SleeperTradedPick } from "../types";
import { optimizeLineup } from "./lineup";

/**
 * Roster-management intelligence: IR hygiene, drop/add upgrade pairs, taxi
 * squad advice, and the offseason roster-crunch forecast. All read-only
 * advice — the dashboard can't touch the roster, and irreversible moves
 * (taxi activations) are flagged so the UI can warn accordingly.
 */

interface ValueLike {
  value: number;
}

/** Roster spots that count against the active-roster limit (BN yes, IR/TAXI no). */
export function activeCapacity(league: SleeperLeague): number {
  return league.roster_positions.filter((p) => p !== "IR" && p !== "TAXI").length;
}

/** Players occupying active-roster spots (everyone minus IR minus taxi). */
export function activeIds(roster: SleeperRoster): string[] {
  const parked = new Set([...(roster.reserve ?? []), ...(roster.taxi ?? [])]);
  return (roster.players ?? []).filter((id) => !parked.has(id));
}

// ---------- IR hygiene ----------

/** Statuses that make a player IR-slot eligible in Sleeper's default rules. */
const IR_ELIGIBLE = new Set(["IR", "Out", "PUP", "COV", "DNR", "NA"]);

export interface IrAdvice {
  kind: "stash" | "activate";
  playerId: string;
  status: string | null;
  reason: string;
}

export function irAdvice(league: SleeperLeague, roster: SleeperRoster, players: PlayerMap): IrAdvice[] {
  const slots = league.settings.reserve_slots ?? 0;
  const reserve = roster.reserve ?? [];
  const open = slots - reserve.length;
  const out: IrAdvice[] = [];

  if (open > 0) {
    const candidates = activeIds(roster).filter((id) => {
      const st = players[id]?.injury_status;
      return st != null && IR_ELIGIBLE.has(st);
    });
    for (const id of candidates.slice(0, open)) {
      out.push({
        kind: "stash",
        playerId: id,
        status: players[id]?.injury_status ?? null,
        reason: `ruled out (${players[id]?.injury_status}) and IR-eligible — the move frees an active roster spot`,
      });
    }
  }

  for (const id of reserve) {
    const st = players[id]?.injury_status ?? null;
    if (st == null || !IR_ELIGIBLE.has(st)) {
      out.push({
        kind: "activate",
        playerId: id,
        status: st,
        reason: st
          ? `only ${st} — likely no longer IR-eligible, Sleeper may lock your lineup until he's activated`
          : "healthy — activate him (you'll need an open active spot)",
      });
    }
  }
  return out;
}

// ---------- Drop candidates / upgrade pairs ----------

/** One blended "how much is this roster spot producing" score: dynasty value + weekly proj. */
export function holdScore(value: number, proj: number): number {
  return Math.round((value + Math.min(30, proj * 1.5)) * 10) / 10;
}

export interface UpgradePair {
  dropId: string;
  addId: string;
  position: string;
  dropScore: number;
  addScore: number;
  netValue: number;
  netProj: number;
}

/**
 * Bench players a free agent strictly outclasses: for each active non-starter,
 * compare against the best unrostered player at his position. Only pairs
 * clearing `margin` in blended score are suggested — a drop is forever, so the
 * bar is deliberately higher than waiver-target scoring.
 */
export function upgradePairs(
  myRoster: SleeperRoster,
  rosters: SleeperRoster[],
  players: PlayerMap,
  values: Record<string, ValueLike>,
  projPts: (id: string) => number,
  margin = 3,
): UpgradePair[] {
  const rostered = new Set<string>();
  for (const r of rosters) for (const id of r.players ?? []) rostered.add(id);

  // Best free agent per position (players map is large — one pass).
  const bestFa: Record<string, { id: string; score: number }> = {};
  for (const [id, p] of Object.entries(players)) {
    if (rostered.has(id) || !p.team || !p.position) continue;
    if (p.injury_status && IR_ELIGIBLE.has(p.injury_status)) continue; // don't suggest adding ruled-out players
    const score = holdScore(values[id]?.value ?? 0, projPts(id));
    if (score > (bestFa[p.position]?.score ?? 0)) bestFa[p.position] = { id, score };
  }

  const starters = new Set((myRoster.starters ?? []).filter((s) => s && s !== "0"));
  const parked = new Set([...(myRoster.reserve ?? []), ...(myRoster.taxi ?? [])]);
  const bench = (myRoster.players ?? []).filter((id) => !starters.has(id) && !parked.has(id) && players[id]);

  const pairs: UpgradePair[] = [];
  for (const id of bench) {
    const pos = players[id]?.position;
    if (!pos) continue;
    const fa = bestFa[pos];
    if (!fa) continue;
    const myScore = holdScore(values[id]?.value ?? 0, projPts(id));
    if (fa.score >= myScore + margin) {
      pairs.push({
        dropId: id,
        addId: fa.id,
        position: pos,
        dropScore: myScore,
        addScore: fa.score,
        netValue: Math.round(((values[fa.id]?.value ?? 0) - (values[id]?.value ?? 0)) * 10) / 10,
        netProj: Math.round((projPts(fa.id) - projPts(id)) * 10) / 10,
      });
    }
  }
  return pairs.sort((a, b) => b.addScore - b.dropScore - (a.addScore - a.dropScore));
}

/** Bench ranked weakest-first — the order you'd cut in a roster crunch. */
export function weakestHolds(
  myRoster: SleeperRoster,
  players: PlayerMap,
  values: Record<string, ValueLike>,
  projPts: (id: string) => number,
): { playerId: string; score: number }[] {
  const starters = new Set((myRoster.starters ?? []).filter((s) => s && s !== "0"));
  const parked = new Set([...(myRoster.reserve ?? []), ...(myRoster.taxi ?? [])]);
  return (myRoster.players ?? [])
    .filter((id) => !starters.has(id) && !parked.has(id) && players[id])
    .map((playerId) => ({ playerId, score: holdScore(values[playerId]?.value ?? 0, projPts(playerId)) }))
    .sort((a, b) => a.score - b.score);
}

// ---------- Taxi squad ----------

export interface TaxiAdvice {
  kind: "promote" | "stash";
  playerId: string;
  /** projected weekly lineup gain (promote only) */
  gain?: number;
  /** activating off taxi can't be undone — the UI must warn before this one */
  irreversible: boolean;
  reason: string;
}

/** Lineup-improvement bar a taxi promotion must clear — it's a one-way door. */
export const PROMOTE_THRESHOLD = 1.5;

export function taxiAdvice(
  league: SleeperLeague,
  roster: SleeperRoster,
  players: PlayerMap,
  values: Record<string, ValueLike>,
  projPts: (id: string) => number,
): { slots: number; used: number; open: number; moves: TaxiAdvice[] } {
  const slots = league.settings.taxi_slots ?? 0;
  const taxi = (roster.taxi ?? []).filter((id) => players[id]);
  const moves: TaxiAdvice[] = [];
  if (slots === 0) return { slots, used: 0, open: 0, moves };

  const active = activeIds(roster);
  const base = optimizeLineup(league, active, players, projPts, { excludeUnavailable: true });

  // Promote: only when the rookie would crack the starting lineup by a clear
  // margin. Held to a high bar because activation is irreversible.
  for (const id of taxi) {
    const withHim = optimizeLineup(league, [...active, id], players, projPts, { excludeUnavailable: true });
    const gain = Math.round((withHim.totalProjected - base.totalProjected) * 10) / 10;
    if (gain >= PROMOTE_THRESHOLD) {
      moves.push({
        kind: "promote",
        playerId: id,
        gain,
        irreversible: true,
        reason: `would improve your starting lineup by ${gain} proj pts`,
      });
    }
  }

  // Stash: an eligible young player parked on the active roster while a taxi
  // slot sits open — that's a free roster spot going unused. Skip anyone the
  // optimal lineup actually wants to start.
  const open = slots - taxi.length;
  if (open > 0) {
    const maxYears = league.settings.taxi_years ?? 2;
    const inOptimal = new Set(base.slots.map((s) => s.playerId).filter(Boolean));
    const starters = new Set((roster.starters ?? []).filter((s) => s && s !== "0"));
    const eligible = active
      .filter((id) => {
        const p = players[id];
        return (
          p &&
          (p.years_exp ?? 99) < maxYears &&
          !inOptimal.has(id) &&
          !starters.has(id) &&
          p.position !== "K" &&
          p.position !== "DEF"
        );
      })
      .sort((a, b) => (values[b]?.value ?? 0) - (values[a]?.value ?? 0));
    for (const id of eligible.slice(0, open)) {
      moves.push({
        kind: "stash",
        playerId: id,
        irreversible: false,
        reason: "taxi-eligible but occupying an active roster spot — stashing frees the spot (check your league's stash deadline)",
      });
    }
  }
  return { slots, used: taxi.length, open, moves };
}

// ---------- Roster crunch forecast ----------

export interface CrunchForecast {
  capacity: number;
  active: number;
  open: number;
  nextSeason: string;
  incomingPicks: number;
  cutsNeeded: number;
}

/**
 * How many players must be cut to fit next season's rookie class: incoming
 * picks (native rounds ± trades) vs open active-roster spots today.
 */
export function rosterCrunch(
  league: SleeperLeague,
  roster: SleeperRoster,
  tradedPicks: SleeperTradedPick[],
  currentSeason: string,
  rookieRounds = 4,
): CrunchForecast {
  const capacity = activeCapacity(league);
  const active = activeIds(roster).length;
  const open = Math.max(0, capacity - active);
  const nextSeason = String(Number(currentSeason) + 1);
  const mine = roster.roster_id;

  const lost = tradedPicks.filter(
    (p) => p.season === nextSeason && p.roster_id === mine && p.owner_id !== mine && p.round <= rookieRounds,
  ).length;
  const acquired = tradedPicks.filter(
    (p) => p.season === nextSeason && p.owner_id === mine && p.roster_id !== mine && p.round <= rookieRounds,
  ).length;
  const incomingPicks = Math.max(0, rookieRounds - lost) + acquired;

  return {
    capacity,
    active,
    open,
    nextSeason,
    incomingPicks,
    cutsNeeded: Math.max(0, incomingPicks - open),
  };
}

// ---------- Hold / sell badges ----------

export type HoldBadge = "young-core" | "sell-window" | null;

/** Same thresholds as the Dynasty tab's young-core / sell-window lists. */
export function holdBadge(age: number | null | undefined, value: number): HoldBadge {
  if (age != null && age <= 24 && value >= 5) return "young-core";
  if (age != null && age >= 27 && value >= 10) return "sell-window";
  return null;
}
