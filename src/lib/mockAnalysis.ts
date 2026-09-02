import type { ConsensusRow } from "./guides";
import { pickPosition } from "./draftIntel";
import type { BatchResult, MockPick, MockRun, MockSetup } from "./mockDraft";

/**
 * Read-outs over a batch of mock timelines. All pure; the UI only formats.
 *
 *  - availability matrix: who's still there at each of my picks (heatmap)
 *  - targets: at one pick, best value × availability
 *  - positional runs: when the Nth player at a position typically goes
 *  - typical roster: what my picks usually turn into, slot by slot
 *  - timeline scoring: rank every timeline's rosters with a caller-supplied
 *    scorer (optimal-lineup projection for redraft/startup, dynasty value for
 *    rookie drafts), find best / median / worst, and what had to go right
 */

export interface HeatRow {
  row: ConsensusRow;
  /** P(available) per entry of `picks`, 0..1 */
  pct: number[];
}

export function availabilityMatrix(
  batch: BatchResult,
  board: ConsensusRow[],
  topN = 40,
  maxPicks = 8,
): { picks: number[]; rows: HeatRow[] } {
  const picks = batch.myPickNos.slice(0, maxPicks);
  const rows = board.slice(0, topN).map((row) => ({
    row,
    pct: picks.map((p) => (batch.availability.get(p)?.get(row.key) ?? 0) / Math.max(1, batch.runs)),
  }));
  return { picks, rows };
}

export interface Target {
  row: ConsensusRow;
  pct: number;
  value: number;
  /** value × availability — what you can realistically expect to get */
  score: number;
}

/**
 * Best realistic options at one of my picks. `valueOf` may return null for
 * unpriced players; those fall back to a board-position value so late-round
 * boards without a value model still rank sensibly.
 */
export function targetsAt(
  batch: BatchResult,
  pickNo: number,
  board: ConsensusRow[],
  valueOf: (row: ConsensusRow) => number | null,
  n = 6,
  minPct = 0.2,
): Target[] {
  const tally = batch.availability.get(pickNo);
  if (!tally) return [];
  const fallback = (row: ConsensusRow) => Math.max(1, board.length - row.consensus + 1) / Math.max(1, board.length) * 20;
  return board
    .map((row) => {
      const pct = (tally.get(row.key) ?? 0) / Math.max(1, batch.runs);
      const value = valueOf(row) ?? fallback(row);
      return { row, pct, value, score: value * pct };
    })
    .filter((t) => t.pct >= minPct)
    .sort((a, b) => b.score - a.score || a.row.consensus - b.row.consensus)
    .slice(0, n);
}

export interface PositionRun {
  position: string;
  /** nth player at the position → median overall pick it went (null if it never did) */
  median: (number | null)[];
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

/** median pick at which the Nth QB/RB/WR/TE… left the board across timelines */
export function positionRuns(batch: BatchResult, positions: string[], nths: number[]): PositionRun[] {
  return positions.map((position) => {
    const perNth: number[][] = nths.map(() => []);
    for (const t of batch.timelines) {
      let count = 0;
      for (const p of t.picks) {
        if (p.pickNo <= batch.startedAt || p.position !== position) continue;
        count++;
        const idx = nths.indexOf(count);
        if (idx >= 0) perNth[idx].push(p.pickNo);
      }
    }
    return { position, median: perNth.map(median) };
  });
}

export interface SlotOption {
  key: string;
  displayName: string;
  position: string | null;
  sleeperId: string | null;
  pct: number;
}

export interface TypicalRoster {
  slots: { pickNo: number; options: SlotOption[] }[];
  /** position mix ("2 QB · 5 RB · …") → share of timelines */
  mix: { label: string; pct: number }[];
}

export function typicalRoster(batch: BatchResult, myRosterId: number | null, optionsPerSlot = 4): TypicalRoster {
  const bySlot = new Map<number, Map<string, { pick: MockPick; n: number }>>();
  const mixCount = new Map<string, number>();
  const order = ["QB", "RB", "WR", "TE", "K", "DEF"];
  for (const t of batch.timelines) {
    const mine = t.picks.filter((p) => p.rosterId === myRosterId && p.pickNo > batch.startedAt);
    for (const p of mine) {
      const m = bySlot.get(p.pickNo) ?? new Map();
      const e = m.get(p.key) ?? { pick: p, n: 0 };
      e.n++;
      m.set(p.key, e);
      bySlot.set(p.pickNo, m);
    }
    const counts: Record<string, number> = {};
    for (const p of t.picks.filter((p) => p.rosterId === myRosterId)) {
      if (p.position) counts[p.position] = (counts[p.position] ?? 0) + 1;
    }
    const label = order.filter((pos) => counts[pos]).map((pos) => `${counts[pos]} ${pos}`).join(" · ");
    mixCount.set(label, (mixCount.get(label) ?? 0) + 1);
  }
  const slots = [...bySlot.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pickNo, m]) => ({
      pickNo,
      options: [...m.values()]
        .sort((a, b) => b.n - a.n)
        .slice(0, optionsPerSlot)
        .map(({ pick, n }) => ({
          key: pick.key,
          displayName: pick.displayName,
          position: pick.position,
          sleeperId: pick.sleeperId,
          pct: n / Math.max(1, batch.runs),
        })),
    }));
  const mix = [...mixCount.entries()]
    .map(([label, n]) => ({ label, pct: n / Math.max(1, batch.runs) }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 4);
  return { slots, mix };
}

// ---------- timelines ----------

export interface ScoredTimeline {
  index: number;
  run: MockRun;
  /** roster_id → score (projected starter points, or roster value) */
  scores: Map<number, number>;
  myScore: number;
  /** 1 = strongest roster in the league for this timeline */
  myRank: number;
}

/** roster player ids per team in a timeline: existing roster (rookie mode) + picks */
export function timelineRosters(
  run: MockRun,
  rosterIds: number[],
  baseRosters: Map<number, string[]>,
): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const rid of rosterIds) out.set(rid, [...(baseRosters.get(rid) ?? [])]);
  for (const p of run.picks) {
    if (!p.sleeperId) continue;
    const arr = out.get(p.rosterId);
    if (arr) arr.push(p.sleeperId);
    else out.set(p.rosterId, [p.sleeperId]);
  }
  return out;
}

export function scoreTimelines(
  batch: BatchResult,
  rosterIds: number[],
  myRosterId: number | null,
  baseRosters: Map<number, string[]>,
  scoreRoster: (playerIds: string[]) => number,
): ScoredTimeline[] {
  return batch.timelines.map((run, index) => {
    const rosters = timelineRosters(run, rosterIds, baseRosters);
    const scores = new Map<number, number>();
    for (const [rid, ids] of rosters) scores.set(rid, scoreRoster(ids));
    const myScore = myRosterId != null ? scores.get(myRosterId) ?? 0 : 0;
    const myRank = 1 + [...scores.values()].filter((s) => s > myScore).length;
    return { index, run, scores, myScore, myRank };
  });
}

export interface Percentiles {
  p10: number;
  median: number;
  p90: number;
  mean: number;
}

export function percentiles(xs: number[]): Percentiles {
  if (xs.length === 0) return { p10: 0, median: 0, p90: 0, mean: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
  return {
    p10: at(0.1),
    median: at(0.5),
    p90: at(0.9),
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
}

/** best / median / worst timelines for me, by my score */
export function pickTimelines(scored: ScoredTimeline[]): { best: ScoredTimeline; median: ScoredTimeline; worst: ScoredTimeline } | null {
  if (scored.length === 0) return null;
  const sorted = [...scored].sort((a, b) => b.myScore - a.myScore);
  return { best: sorted[0], median: sorted[Math.floor(sorted.length / 2)], worst: sorted[sorted.length - 1] };
}

export interface LuckyPick {
  pick: MockPick;
  /** how often he was still there at that pick across the batch */
  pct: number;
}

/** my picks in a timeline that were on the board less than `threshold` of the time */
export function whatHadToGoRight(
  run: MockRun,
  batch: BatchResult,
  myRosterId: number | null,
  threshold = 0.5,
): LuckyPick[] {
  const out: LuckyPick[] = [];
  for (const p of run.picks) {
    if (p.rosterId !== myRosterId || p.pickNo <= batch.startedAt) continue;
    const tally = batch.availability.get(p.pickNo);
    if (!tally) continue;
    const pct = (tally.get(p.key) ?? 0) / Math.max(1, batch.runs);
    if (pct < threshold) out.push({ pick: p, pct });
  }
  return out.sort((a, b) => a.pct - b.pct);
}

export function pickLabelFor(setup: MockSetup, pickNo: number): string {
  const { round, slot } = pickPosition(pickNo, setup.teams, setup.type);
  return `R${round}.${String(slot).padStart(2, "0")}`;
}
