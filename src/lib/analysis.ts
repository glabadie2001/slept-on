import type {
  PlayerMap,
  SleeperLeague,
  SleeperRoster,
  SleeperTradedPick,
  SleeperTransaction,
  TeamInfo,
  TrendingPlayer,
} from "../types";
import { optimizeLineup, startingSlots, SLOT_ELIGIBILITY } from "./lineup";
import type { PlayerValue } from "./value";
import { pickValue } from "./value";

// ---------- Power rankings ----------

export interface PowerRank {
  rosterId: number;
  score: number; // 0-100
  starterStrength: number; // sum of starters' win-now score
  rosterValue: number; // sum of dynasty values (top 25 players)
  record: string;
  fpts: number;
  rank: number;
}

export function powerRankings(
  league: SleeperLeague,
  rosters: SleeperRoster[],
  players: PlayerMap,
  values: Record<string, PlayerValue>,
  projectedPts: (id: string) => number,
): PowerRank[] {
  const rows = rosters.map((r) => {
    const ids = r.players ?? [];
    const optimal = optimizeLineup(league, ids, players, projectedPts);
    const starterStrength = optimal.totalProjected;
    const rosterValue = ids
      .map((id) => values[id]?.value ?? 0)
      .sort((a, b) => b - a)
      .slice(0, 25)
      .reduce((s, v) => s + v, 0);
    const { wins, losses, ties, fpts } = r.settings;
    return {
      rosterId: r.roster_id,
      starterStrength,
      rosterValue,
      record: `${wins}-${losses}${ties ? `-${ties}` : ""}`,
      fpts: fpts + (r.settings.fpts_decimal ?? 0) / 100,
      wins,
      games: wins + losses + ties,
    };
  });

  const maxStarter = Math.max(1, ...rows.map((r) => r.starterStrength));
  const maxValue = Math.max(1, ...rows.map((r) => r.rosterValue));
  const maxFpts = Math.max(1, ...rows.map((r) => r.fpts));

  const ranked = rows
    .map((r) => {
      const winPct = r.games > 0 ? r.wins / r.games : 0.5;
      const score =
        45 * (r.starterStrength / maxStarter) +
        30 * (r.rosterValue / maxValue) +
        15 * (maxFpts > 1 ? r.fpts / maxFpts : 0.5) +
        10 * winPct;
      return { ...r, score: Math.round(score * 10) / 10 };
    })
    .sort((a, b) => b.score - a.score)
    .map((r, i) => ({
      rosterId: r.rosterId,
      score: r.score,
      starterStrength: Math.round(r.starterStrength * 10) / 10,
      rosterValue: Math.round(r.rosterValue),
      record: r.record,
      fpts: Math.round(r.fpts * 10) / 10,
      rank: i + 1,
    }));
  return ranked;
}

// ---------- Positional needs (used by waivers + trades) ----------

export interface PositionalStrength {
  position: string;
  startersNeeded: number;
  quality: number; // avg value of the players who'd start there
}

export function positionalNeeds(
  league: SleeperLeague,
  roster: SleeperRoster,
  players: PlayerMap,
  values: Record<string, PlayerValue>,
): PositionalStrength[] {
  const slots = startingSlots(league);
  const needCount: Record<string, number> = {};
  for (const slot of slots) {
    const elig = SLOT_ELIGIBILITY[slot];
    if (elig.length === 1) needCount[elig[0]] = (needCount[elig[0]] ?? 0) + 1;
  }
  // Flex demand spreads across RB/WR/TE.
  const flexes = slots.filter((s) => SLOT_ELIGIBILITY[s].length > 1).length;
  for (const pos of ["RB", "WR"]) needCount[pos] = (needCount[pos] ?? 0) + flexes * 0.4;
  needCount.TE = (needCount.TE ?? 0) + flexes * 0.2;

  const byPos: Record<string, number[]> = {};
  for (const id of roster.players ?? []) {
    const pos = players[id]?.position;
    if (!pos) continue;
    (byPos[pos] ??= []).push(values[id]?.value ?? 0);
  }

  // K/DEF are excluded: they'd otherwise dominate "weakest position" and steer
  // waiver boosts / trade suggestions toward positions nobody trades for.
  return Object.entries(needCount)
    .filter(([pos, n]) => n > 0 && pos !== "K" && pos !== "DEF")
    .map(([position, startersNeeded]) => {
      const vals = (byPos[position] ?? []).sort((a, b) => b - a);
      const need = Math.ceil(startersNeeded);
      const top = vals.slice(0, Math.max(1, need));
      const quality = top.length ? top.reduce((s, v) => s + v, 0) / Math.max(need, top.length) : 0;
      return { position, startersNeeded, quality: Math.round(quality * 10) / 10 };
    })
    .sort((a, b) => a.quality - b.quality);
}

// ---------- Waivers ----------

export interface WaiverTarget {
  playerId: string;
  score: number;
  trendCount: number;
  reason: string;
}

export function waiverTargets(
  rosters: SleeperRoster[],
  players: PlayerMap,
  values: Record<string, PlayerValue>,
  trendingAdds: TrendingPlayer[],
  myNeeds: PositionalStrength[],
  projectedPts: (id: string) => number,
): WaiverTarget[] {
  const rostered = new Set<string>();
  for (const r of rosters) for (const id of r.players ?? []) rostered.add(id);
  const trendMap = new Map(trendingAdds.map((t) => [t.player_id, t.count]));
  const maxTrend = Math.max(1, ...trendingAdds.map((t) => t.count));
  const weakPositions = new Set(myNeeds.slice(0, 2).map((n) => n.position));

  const targets: WaiverTarget[] = [];
  for (const [id, p] of Object.entries(players)) {
    if (rostered.has(id) || !p.team) continue;
    const v = values[id];
    const trend = trendMap.get(id) ?? 0;
    const proj = projectedPts(id);
    if ((v?.value ?? 0) < 1 && trend === 0 && proj < 2) continue;

    const needBoost = p.position && weakPositions.has(p.position) ? 1.25 : 1;
    const score =
      (0.45 * (v?.value ?? 0) + 0.25 * Math.min(30, proj * 2) + 30 * (trend / maxTrend)) * needBoost;

    const reasons: string[] = [];
    if (trend > 0) reasons.push(`${trend.toLocaleString()} adds in 48h`);
    if ((v?.value ?? 0) >= 10) reasons.push(`dynasty value ${v!.value}`);
    if (proj >= 8) reasons.push(`projects ${proj.toFixed(1)} pts`);
    if (p.position && weakPositions.has(p.position)) reasons.push(`fills your ${p.position} need`);

    targets.push({
      playerId: id,
      score: Math.round(score * 10) / 10,
      trendCount: trend,
      reason: reasons.join(" · ") || "deep stash",
    });
  }
  return targets.sort((a, b) => b.score - a.score).slice(0, 40);
}

// ---------- Trades ----------

export interface TradeSuggestion {
  targetRosterId: number;
  give: string[]; // player ids
  get: string[];
  giveValue: number;
  getValue: number;
  rationale: string;
}

/**
 * Suggest 1-for-1 and 2-for-1 trades: find partners whose surplus matches my
 * need (and vice versa), where the value swing is plausible enough that a real
 * manager might accept (within ~15% for them) but still improves my roster.
 */
export function tradeSuggestions(
  league: SleeperLeague,
  myRoster: SleeperRoster,
  otherRosters: SleeperRoster[],
  players: PlayerMap,
  values: Record<string, PlayerValue>,
): TradeSuggestion[] {
  const myNeeds = positionalNeeds(league, myRoster, players, values);
  const suggestions: TradeSuggestion[] = [];
  const myIds = (myRoster.players ?? []).filter((id) => players[id]);

  for (const theirs of otherRosters) {
    const theirNeeds = positionalNeeds(league, theirs, players, values);
    const theirWeak = new Set(theirNeeds.slice(0, 2).map((n) => n.position));
    const myWeak = new Set(myNeeds.slice(0, 2).map((n) => n.position));
    const theirIds = (theirs.players ?? []).filter((id) => players[id]);

    for (const mine of myIds) {
      const mp = players[mine];
      const mv = values[mine]?.value ?? 0;
      if (!mp.position || mv < 5) continue;
      // Offer from my surplus positions into their weakness.
      if (!theirWeak.has(mp.position) || myWeak.has(mp.position)) continue;

      for (const target of theirIds) {
        const tp = players[target];
        const tv = values[target]?.value ?? 0;
        if (!tp.position || !myWeak.has(tp.position)) continue;
        // Fair-ish for them, good for me: they lose ≤ ~8 value, I gain > 3.
        const netForMe = tv - mv;
        const fairForThem = mv >= tv * 0.85;
        if (netForMe > 2 && fairForThem) {
          suggestions.push({
            targetRosterId: theirs.roster_id,
            give: [mine],
            get: [target],
            giveValue: mv,
            getValue: tv,
            rationale: `They need ${mp.position}, you need ${tp.position}`,
          });
        }
      }
    }
  }
  return suggestions
    .sort((a, b) => b.getValue - b.giveValue - (a.getValue - a.giveValue))
    .slice(0, 12);
}

export function evaluateTrade(
  giveIds: string[],
  getIds: string[],
  givePicks: SleeperTradedPick[],
  getPicks: SleeperTradedPick[],
  values: Record<string, PlayerValue>,
  currentSeason: string,
  pickVal: (pick: SleeperTradedPick) => number = (p) => pickValue(p, currentSeason),
): { giveValue: number; getValue: number; verdict: string } {
  const sum = (ids: string[], picks: SleeperTradedPick[]) =>
    ids.reduce((s, id) => s + (values[id]?.value ?? 0), 0) +
    picks.reduce((s, p) => s + pickVal(p), 0);
  const giveValue = Math.round(sum(giveIds, givePicks) * 10) / 10;
  const getValue = Math.round(sum(getIds, getPicks) * 10) / 10;
  const diff = getValue - giveValue;
  const pct = giveValue > 0 ? diff / giveValue : 0;
  let verdict: string;
  if (pct > 0.2) verdict = "Clear win — smash accept";
  else if (pct > 0.05) verdict = "Favorable";
  else if (pct > -0.05) verdict = "Fair — decide on roster fit";
  else if (pct > -0.2) verdict = "Unfavorable";
  else verdict = "Clear loss — decline";
  return { giveValue, getValue, verdict };
}

// ---------- Injuries ----------

export type InjurySeverity = "critical" | "serious" | "warning";

export interface InjuryAlert {
  playerId: string;
  status: string;
  severity: InjurySeverity;
  isStarter: boolean;
  note: string | null;
}

const SEVERITY: Record<string, InjurySeverity> = {
  Out: "critical",
  IR: "critical",
  PUP: "critical",
  Sus: "critical",
  COV: "critical",
  NA: "serious",
  DNR: "critical",
  Doubtful: "serious",
  Questionable: "warning",
};

export function injuryAlerts(roster: SleeperRoster, players: PlayerMap): InjuryAlert[] {
  const starters = new Set((roster.starters ?? []).filter((s) => s && s !== "0"));
  const alerts: InjuryAlert[] = [];
  for (const id of roster.players ?? []) {
    const p = players[id];
    if (!p?.injury_status) continue;
    const severity = SEVERITY[p.injury_status] ?? "warning";
    alerts.push({
      playerId: id,
      status: p.injury_status,
      severity,
      isStarter: starters.has(id),
      note: p.injury_notes ?? p.injury_body_part ?? null,
    });
  }
  const order: InjurySeverity[] = ["critical", "serious", "warning"];
  return alerts.sort(
    (a, b) =>
      Number(b.isStarter) - Number(a.isStarter) ||
      order.indexOf(a.severity) - order.indexOf(b.severity),
  );
}

// ---------- Team helpers ----------

export function buildTeams(
  users: { user_id: string; display_name: string; avatar: string | null; metadata?: { team_name?: string } | null }[],
  rosters: SleeperRoster[],
  myUserId: string,
): TeamInfo[] {
  const byUser = new Map(users.map((u) => [u.user_id, u]));
  return rosters.map((r) => {
    const u = r.owner_id ? byUser.get(r.owner_id) : undefined;
    const isMine =
      r.owner_id === myUserId || (r.co_owners ?? [])?.includes?.(myUserId) === true;
    return {
      rosterId: r.roster_id,
      ownerId: r.owner_id,
      teamName: u?.metadata?.team_name || u?.display_name || `Team ${r.roster_id}`,
      ownerName: u?.display_name ?? "(orphan)",
      avatar: u?.avatar ?? null,
      roster: r,
      isMine,
    };
  });
}

/** Win probability for A vs B given projected totals (normal model, σ≈9/side). */
export function winProbability(projA: number, projB: number): number {
  const sigma = 12.7; // sqrt(2) * ~9 per team
  const z = (projA - projB) / sigma;
  // Abramowitz-Stegun approximation of Φ(z)
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  let p = 1 - d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z < 0) p = 1 - p;
  return Math.round(p * 100);
}

/** Grade a completed trade transaction from a roster's perspective. */
export function tradeLedger(
  transactions: SleeperTransaction[],
  values: Record<string, PlayerValue>,
  currentSeason: string,
  pickVal: (pick: SleeperTradedPick) => number = (p) => pickValue(p, currentSeason),
): {
  tx: SleeperTransaction;
  perRoster: Record<number, { in: string[]; out: string[]; picksIn: SleeperTradedPick[]; picksOut: SleeperTradedPick[]; net: number }>;
}[] {
  return transactions
    .filter((t) => t.type === "trade" && t.status === "complete")
    .map((tx) => {
      const perRoster: Record<
        number,
        { in: string[]; out: string[]; picksIn: SleeperTradedPick[]; picksOut: SleeperTradedPick[]; net: number }
      > = {};
      for (const rid of tx.roster_ids) {
        perRoster[rid] = { in: [], out: [], picksIn: [], picksOut: [], net: 0 };
      }
      for (const [pid, rid] of Object.entries(tx.adds ?? {})) perRoster[rid]?.in.push(pid);
      for (const [pid, rid] of Object.entries(tx.drops ?? {})) perRoster[rid]?.out.push(pid);
      for (const pk of tx.draft_picks ?? []) {
        const pickShape: SleeperTradedPick = { ...pk, previous_owner_id: pk.previous_owner_id };
        perRoster[pk.owner_id]?.picksIn.push(pickShape);
        perRoster[pk.previous_owner_id]?.picksOut.push(pickShape);
      }
      for (const rec of Object.values(perRoster)) {
        const inV =
          rec.in.reduce((s, id) => s + (values[id]?.value ?? 0), 0) +
          rec.picksIn.reduce((s, p) => s + pickVal(p), 0);
        const outV =
          rec.out.reduce((s, id) => s + (values[id]?.value ?? 0), 0) +
          rec.picksOut.reduce((s, p) => s + pickVal(p), 0);
        rec.net = Math.round((inV - outV) * 10) / 10;
      }
      return { tx, perRoster };
    });
}
