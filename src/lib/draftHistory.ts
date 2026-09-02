import type { PlayerMap, SleeperDraft, SleeperDraftPick } from "../types";

/**
 * How your leaguemates actually draft, from this league's own past drafts.
 *
 * Picks are attributed to the *person* (picked_by user_id), not the roster
 * slot, because roster_ids get reassigned and teams change hands. Per owner we
 * derive a few transparent tendencies, shrink them toward the league-wide
 * prior (1–3 drafts is thin evidence), and turn them into multipliers the mock
 * engine's need-weighted taste model can use.
 */

export interface HistoricalDraft {
  season: string;
  draftId: string;
  type: SleeperDraft["type"];
  rounds: number;
  teams: number;
  /** was this a dynasty rookie-only draft (short) or a full roster draft */
  rookieDraft: boolean;
  picks: SleeperDraftPick[];
  /** Sleeper ADP for that season by player_id (overall pick), when we could get it */
  adp?: Record<string, number> | null;
}

export interface OwnerTendency {
  userId: string;
  drafts: number;
  /** median first-QB pick as a fraction of the draft (0 = first pick, 1 = last); null if never took one */
  firstQb: number | null;
  firstTe: number | null;
  /** RB / (RB + WR) among the owner's picks in the first third of the draft */
  rbShareEarly: number | null;
  /** mean (ADP − pick) in picks, / teams: +1 = took players a full round before ADP on average */
  reach: number | null;
  /** share of picks spent on rookies (full-roster drafts only) */
  rookieShare: number | null;
}

export interface LeagueTendencies {
  owners: Map<string, OwnerTendency>;
  /** pooled across every pick in the history */
  league: OwnerTendency;
  seasons: string[];
  drafts: number;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

interface Acc {
  drafts: Set<string>;
  firstQb: number[];
  firstTe: number[];
  earlyRb: number;
  earlyWr: number;
  reach: number[];
  rookiePicks: number;
  fullDraftPicks: number;
}
const acc = (): Acc => ({ drafts: new Set(), firstQb: [], firstTe: [], earlyRb: 0, earlyWr: 0, reach: [], rookiePicks: 0, fullDraftPicks: 0 });

function finish(userId: string, a: Acc): OwnerTendency {
  const early = a.earlyRb + a.earlyWr;
  return {
    userId,
    drafts: a.drafts.size,
    firstQb: median(a.firstQb),
    firstTe: median(a.firstTe),
    rbShareEarly: early > 0 ? a.earlyRb / early : null,
    reach: mean(a.reach),
    rookieShare: a.fullDraftPicks > 0 ? a.rookiePicks / a.fullDraftPicks : null,
  };
}

/** was this player a rookie in `season`, judging by today's years_exp */
export function wasRookie(players: PlayerMap, playerId: string, season: string, currentSeason: string): boolean | null {
  const p = players[playerId];
  if (!p || p.years_exp == null) return null;
  const yearsAgo = parseInt(currentSeason, 10) - parseInt(season, 10);
  return p.years_exp - yearsAgo <= 0;
}

export function deriveTendencies(
  history: HistoricalDraft[],
  players: PlayerMap,
  currentSeason: string,
  /** only owners in the current league are worth modelling */
  currentUserIds: Set<string>,
): LeagueTendencies {
  const per = new Map<string, Acc>();
  const all = acc();
  const seasons = new Set<string>();

  for (const d of history) {
    if (d.picks.length === 0) continue;
    seasons.add(d.season);
    const total = Math.max(1, d.teams * d.rounds);
    const earlyCut = Math.ceil(total / 3);
    const byOwner = new Map<string, SleeperDraftPick[]>();
    for (const p of d.picks) {
      if (!p.picked_by || !currentUserIds.has(p.picked_by)) continue;
      const arr = byOwner.get(p.picked_by) ?? [];
      arr.push(p);
      byOwner.set(p.picked_by, arr);
    }
    for (const [userId, picks] of byOwner) {
      const a = per.get(userId) ?? acc();
      per.set(userId, a);
      a.drafts.add(d.draftId);
      all.drafts.add(d.draftId);
      const posOf = (p: SleeperDraftPick) => players[p.player_id]?.position ?? p.metadata?.position ?? null;
      const sorted = [...picks].sort((x, y) => x.pick_no - y.pick_no);
      const firstAt = (pos: string) => {
        const f = sorted.find((p) => posOf(p) === pos);
        return f ? (f.pick_no - 1) / total : null;
      };
      const qb = firstAt("QB");
      const te = firstAt("TE");
      if (qb != null) {
        a.firstQb.push(qb);
        all.firstQb.push(qb);
      }
      if (te != null) {
        a.firstTe.push(te);
        all.firstTe.push(te);
      }
      for (const p of sorted) {
        const pos = posOf(p);
        if (p.pick_no <= earlyCut) {
          if (pos === "RB") {
            a.earlyRb++;
            all.earlyRb++;
          } else if (pos === "WR") {
            a.earlyWr++;
            all.earlyWr++;
          }
        }
        const adp = d.adp?.[p.player_id];
        if (adp != null && adp > 0) {
          const r = (adp - p.pick_no) / Math.max(1, d.teams);
          a.reach.push(r);
          all.reach.push(r);
        }
        if (!d.rookieDraft) {
          const rk = wasRookie(players, p.player_id, d.season, currentSeason);
          if (rk != null) {
            a.fullDraftPicks++;
            all.fullDraftPicks++;
            if (rk) {
              a.rookiePicks++;
              all.rookiePicks++;
            }
          }
        }
      }
    }
  }

  const owners = new Map<string, OwnerTendency>();
  for (const [userId, a] of per) owners.set(userId, finish(userId, a));
  return {
    owners,
    league: finish("league", all),
    seasons: [...seasons].sort(),
    drafts: all.drafts.size,
  };
}

// ---------- shrinkage → multipliers ----------

/**
 * A per-team prior the mock engine understands. Every field is a multiplier
 * around 1 derived from the owner's deviation from the league, shrunk toward
 * 1 by n / (n + k) where n = the owner's drafts and k = `shrink` (in drafts).
 */
export interface TendencyPrior {
  userId: string;
  drafts: number;
  /** multiplier on QB appetite until the owner has a QB (>1 = takes QBs earlier than the league) */
  qbEarly: number;
  /** same for TE */
  teEarly: number;
  /** multiplier on RB appetite in the early third (>1 = RB-heavy); WR gets the inverse */
  rbLean: number;
  /** multiplier on how far down the board the owner will reach (>1 = reachier) */
  reach: number;
  /** multiplier on rookie appetite in full-roster dynasty drafts */
  rookieLean: number;
  /** how much of the owner's own signal survived shrinkage, 0..1 */
  confidence: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function tendencyPrior(owner: OwnerTendency, league: OwnerTendency, shrink: number): TendencyPrior {
  const n = owner.drafts;
  const conf = n > 0 ? n / (n + Math.max(0, shrink)) : 0;
  // deviation in draft-fraction; 0.1 of a draft ≈ 1.5 rounds in a 15-rounder
  const timing = (own: number | null, lg: number | null) => {
    if (own == null || lg == null) return 1;
    const earlier = lg - own; // positive = earlier than league
    return clamp(1 + conf * (earlier / 0.1) * 0.35, 0.5, 2.2);
  };
  const rbLean =
    owner.rbShareEarly != null && league.rbShareEarly != null
      ? clamp(1 + conf * (owner.rbShareEarly - league.rbShareEarly) * 2, 0.6, 1.6)
      : 1;
  const reach =
    owner.reach != null && league.reach != null
      ? clamp(1 + conf * (owner.reach - league.reach) * 0.6, 0.6, 1.8)
      : 1;
  const rookieLean =
    owner.rookieShare != null && league.rookieShare != null
      ? clamp(1 + conf * (owner.rookieShare - league.rookieShare) * 3, 0.5, 2)
      : 1;
  return {
    userId: owner.userId,
    drafts: n,
    qbEarly: timing(owner.firstQb, league.firstQb),
    teEarly: timing(owner.firstTe, league.firstTe),
    rbLean,
    reach,
    rookieLean,
    confidence: Math.round(conf * 100) / 100,
  };
}

/** priors keyed by roster_id for the current league (owners without history get the neutral prior) */
export function priorsByRoster(
  tendencies: LeagueTendencies,
  rosterOwner: Map<number, string | null>,
  shrink: number,
): Map<number, TendencyPrior> {
  const out = new Map<number, TendencyPrior>();
  for (const [rosterId, userId] of rosterOwner) {
    const own = userId ? tendencies.owners.get(userId) : undefined;
    out.set(
      rosterId,
      own
        ? tendencyPrior(own, tendencies.league, shrink)
        : { userId: userId ?? "", drafts: 0, qbEarly: 1, teEarly: 1, rbLean: 1, reach: 1, rookieLean: 1, confidence: 0 },
    );
  }
  return out;
}

/** a rookie draft: dynasty, few rounds relative to a roster */
export function isRookieDraft(d: { rounds: number }, rosterSlots: number): boolean {
  return d.rounds > 0 && d.rounds < Math.max(6, Math.floor(rosterSlots * 0.5));
}

/** how a tendency reads to a human, one line per non-neutral trait */
export function describePrior(p: TendencyPrior): string[] {
  const out: string[] = [];
  const pct = (m: number) => `${Math.round(Math.abs(m - 1) * 100)}%`;
  if (p.qbEarly >= 1.15) out.push(`takes QBs early (+${pct(p.qbEarly)} appetite)`);
  else if (p.qbEarly <= 0.85) out.push(`waits on QB (−${pct(p.qbEarly)})`);
  if (p.teEarly >= 1.15) out.push(`takes TEs early (+${pct(p.teEarly)})`);
  else if (p.teEarly <= 0.85) out.push(`waits on TE (−${pct(p.teEarly)})`);
  if (p.rbLean >= 1.1) out.push(`RB-heavy early (+${pct(p.rbLean)})`);
  else if (p.rbLean <= 0.9) out.push(`WR-heavy early (+${pct(2 - p.rbLean)})`);
  if (p.reach >= 1.15) out.push(`reaches past ADP (+${pct(p.reach)})`);
  else if (p.reach <= 0.85) out.push(`drafts to ADP (−${pct(p.reach)} reach)`);
  if (p.rookieLean >= 1.15) out.push(`rookie-hungry (+${pct(p.rookieLean)})`);
  else if (p.rookieLean <= 0.85) out.push(`avoids rookies (−${pct(p.rookieLean)})`);
  return out;
}
