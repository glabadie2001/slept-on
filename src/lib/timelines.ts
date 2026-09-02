import type { ConsensusRow } from "./guides";
import { advance, nextSlot, rankedChoices, runMocks, needsFor, availableRows } from "./mockDraft";
import type { BatchResult, MockDraft, NeedModel } from "./mockDraft";
import { percentiles, pickTimelines, scoreTimelines } from "./mockAnalysis";
import type { Percentiles, ScoredTimeline } from "./mockAnalysis";
import { simulateSeason, syntheticSchedule } from "./simulator";
import type { SimGame, SimKnobs, SimTeamInput } from "./simulator";

/**
 * Decision-conditioned timelines ("Doctor Strange"): for each candidate at my
 * next pick, run a batch of mocks with that pick forced, score every timeline's
 * rosters, and compare the distributions. The season simulator then turns the
 * median timeline's roster strengths into playoff / title odds — a readable
 * number, but remember the ranking is driven by the deterministic strength
 * scores; the sim is a translation layer, not new information.
 */

export interface CandidateOutcome {
  row: ConsensusRow;
  runs: number;
  /** my roster score distribution across this candidate's timelines */
  score: Percentiles;
  /** my average strength rank in the league (1 = best) */
  avgRank: number;
  /** share of timelines where my roster ranks in the top third */
  topThirdPct: number;
  median: ScoredTimeline;
  best: ScoredTimeline;
  /** playoff / title odds from a season sim of the median timeline (null when not simulated) */
  odds: { playoffPct: number; titlePct: number } | null;
  batch: BatchResult;
}

export interface CompareInput {
  /** the state to branch from — must be my turn (advance untilMine first) */
  base: MockDraft;
  board: ConsensusRow[];
  model: NeedModel;
  candidates: ConsensusRow[];
  runsPerCandidate: number;
  rosterIds: number[];
  baseRosters: Map<number, string[]>;
  scoreRoster: (playerIds: string[]) => number;
  /** when given, season-sim the median timeline of each candidate */
  season?: { games: SimGame[]; playoffTeams: number; sims: number; seed: number } | null;
}

/** the state advanced to my next pick, or null if I have none left */
export function branchPoint(draft: MockDraft, board: ConsensusRow[], model: NeedModel): MockDraft | null {
  const at = advance(draft, board, model, true);
  const slot = nextSlot(at);
  if (!slot || slot.rosterId !== at.setup.myRosterId) return null;
  return at;
}

/** top-k need-weighted options for me at the branch point */
export function candidatesAt(at: MockDraft, board: ConsensusRow[], model: NeedModel, k: number): ConsensusRow[] {
  const slot = nextSlot(at);
  if (!slot) return [];
  const need = needsFor(model, at, slot.rosterId, slot.round);
  return rankedChoices(availableRows(board, at), need, k);
}

export function seasonOdds(
  scores: Map<number, number>,
  myRosterId: number,
  season: { games: SimGame[]; playoffTeams: number; sims: number; seed: number },
): { playoffPct: number; titlePct: number } {
  const teams: SimTeamInput[] = [...scores.entries()].map(([rosterId, projPpg]) => ({
    rosterId,
    wins: 0,
    losses: 0,
    ties: 0,
    fpts: 0,
    weeklyScores: [],
    projPpg,
  }));
  const knobs: SimKnobs = {
    sims: season.sims,
    seed: season.seed,
    blend: 1,
    recencyHalfLife: null,
    volatility: null,
    playoffTeams: season.playoffTeams,
    medianWins: false,
    forced: {},
    boosts: {},
  };
  const out = simulateSeason(teams, season.games, knobs, myRosterId);
  const me = out.teams.find((t) => t.rosterId === myRosterId);
  return { playoffPct: me?.playoffPct ?? 0, titlePct: me?.titlePct ?? 0 };
}

export function compareCandidates(input: CompareInput): CandidateOutcome[] {
  const slot = nextSlot(input.base);
  if (!slot) return [];
  const myRosterId = input.base.setup.myRosterId;
  return input.candidates.map((row, i) => {
    const base: MockDraft = { ...input.base, setup: { ...input.base.setup, seed: (input.base.setup.seed + (i + 1) * 7_919) | 0 } };
    const batch = runMocks(base, input.board, input.model, input.runsPerCandidate, {
      forced: { [slot.pickNo]: row.key },
      tallyDepth: 40,
    });
    const scored = scoreTimelines(batch, input.rosterIds, myRosterId, input.baseRosters, input.scoreRoster);
    const picked = pickTimelines(scored)!;
    const n = Math.max(1, scored.length);
    const teams = Math.max(1, input.rosterIds.length);
    const odds =
      input.season && myRosterId != null
        ? seasonOdds(picked.median.scores, myRosterId, { ...input.season, seed: input.season.seed + i })
        : null;
    return {
      row,
      runs: batch.runs,
      score: percentiles(scored.map((s) => s.myScore)),
      avgRank: scored.reduce((s, t) => s + t.myRank, 0) / n,
      topThirdPct: scored.filter((t) => t.myRank <= Math.ceil(teams / 3)).length / n,
      median: picked.median,
      best: picked.best,
      odds,
      batch,
    };
  });
}

/** a season to simulate: the league's real remaining schedule when it has one, else a round robin */
export function seasonFor(
  rosterIds: number[],
  realGames: SimGame[],
  regularSeasonWeeks: number,
  playoffTeams: number,
  sims: number,
  seed: number,
): { games: SimGame[]; playoffTeams: number; sims: number; seed: number } {
  const games =
    realGames.length > 0
      ? realGames
      : syntheticSchedule(rosterIds, Array.from({ length: regularSeasonWeeks }, (_, i) => i + 1), seed);
  return { games, playoffTeams, sims, seed };
}
