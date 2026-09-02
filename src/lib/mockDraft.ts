import { CONSIDERATION_SET, TASTE_DECAY, pickNeedMultipliers, pickPosition } from "./draftIntel";
import type { DraftMode } from "./draftMode";
import type { ConsensusRow } from "./guides";
import { mulberry32 } from "./simulator";
import type { SleeperDraft, SleeperLeague, SleeperTradedPick } from "../types";

/**
 * Mock draft engine — pure functions over the consensus board.
 *
 * CPU teams pick from the top of the available board with exponentially
 * decaying taste (the same TASTE_DECAY / CONSIDERATION_SET the survival odds
 * use) scaled by positional need, which evolves as they draft:
 *   rookie  → roster-derived appetite (needMultipliers), cooled by each pick
 *   startup / redraft → pick-based appetite (pickNeedMultipliers): fill your
 *             starters, bench to taste, K/DEF at the end
 *
 * Every CPU pick is seeded by (setup.seed, pickNo) so a mock is reproducible,
 * undo doesn't reshuffle the future, and batch runs are just different seeds.
 */

export interface MockSetup {
  teams: number;
  rounds: number;
  type: "snake" | "linear";
  /** draft slot (as string) → roster_id */
  slotToRoster: Record<string, number>;
  season: string;
  tradedPicks: SleeperTradedPick[];
  myRosterId: number | null;
  seed: number;
}

export interface MockPick {
  pickNo: number;
  round: number;
  slot: number;
  rosterId: number;
  /** consensus-board key (normalized name); real picks off the board get "sleeper:<id>" */
  key: string;
  displayName: string;
  position: string | null;
  sleeperId: string | null;
  mine: boolean;
  /** chosen by the engine (CPU or auto-pick for me) rather than clicked */
  auto: boolean;
  /** already made in the real Sleeper draft — immutable in the mock */
  real: boolean;
}

export interface MockDraft {
  setup: MockSetup;
  picks: MockPick[];
}

export interface NeedModel {
  mode: DraftMode;
  league: SleeperLeague;
  /** rookie mode: roster-derived base appetite per roster_id */
  base: Map<number, Record<string, number>>;
}

// ---------- setup ----------

export function setupFromSleeperDraft(
  draft: SleeperDraft,
  tradedPicks: SleeperTradedPick[],
  myRosterId: number | null,
  seed: number,
  rounds?: number,
): MockSetup | null {
  const teams = draft.settings.teams ?? Object.keys(draft.slot_to_roster_id ?? {}).length;
  if (!teams || !draft.slot_to_roster_id) return null;
  return {
    teams,
    rounds: rounds ?? draft.settings.rounds ?? 4,
    type: draft.type === "snake" ? "snake" : "linear",
    slotToRoster: draft.slot_to_roster_id,
    season: draft.season,
    tradedPicks,
    myRosterId,
    seed,
  };
}

/** no Sleeper draft (yet): I take `mySlot`, everyone else is shuffled by seed */
export function syntheticSetup(
  rosterIds: number[],
  myRosterId: number | null,
  mySlot: number,
  rounds: number,
  type: "snake" | "linear",
  season: string,
  seed: number,
): MockSetup {
  const rand = mulberry32(seed ^ 0x5eed);
  const others = rosterIds.filter((r) => r !== myRosterId);
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [others[i], others[j]] = [others[j], others[i]];
  }
  const slotToRoster: Record<string, number> = {};
  const slot = Math.min(Math.max(1, mySlot), rosterIds.length);
  let k = 0;
  for (let s = 1; s <= rosterIds.length; s++) {
    slotToRoster[String(s)] = s === slot && myRosterId != null ? myRosterId : others[k++];
  }
  return { teams: rosterIds.length, rounds, type, slotToRoster, season, tradedPicks: [], myRosterId, seed };
}

export function totalPicks(setup: MockSetup): number {
  return setup.teams * setup.rounds;
}

export interface Slot {
  pickNo: number;
  round: number;
  slot: number;
  rosterId: number;
}

/** who owns overall pick `pickNo`, honoring traded picks */
export function slotAt(setup: MockSetup, pickNo: number): Slot | null {
  if (pickNo < 1 || pickNo > totalPicks(setup)) return null;
  const { round, slot } = pickPosition(pickNo, setup.teams, setup.type);
  const original = setup.slotToRoster[String(slot)];
  if (original == null) return null;
  const trade = setup.tradedPicks.find(
    (t) => t.season === setup.season && t.round === round && t.roster_id === original,
  );
  return { pickNo, round, slot, rosterId: trade ? trade.owner_id : original };
}

export function nextSlot(draft: MockDraft): Slot | null {
  return slotAt(draft.setup, draft.picks.length + 1);
}

export function myPickNumbers(setup: MockSetup): number[] {
  const out: number[] = [];
  for (let p = 1; p <= totalPicks(setup); p++) {
    if (slotAt(setup, p)?.rosterId === setup.myRosterId) out.push(p);
  }
  return out;
}

export function pickLabel(s: { round: number; slot: number }): string {
  return `R${s.round}.${String(s.slot).padStart(2, "0")}`;
}

// ---------- needs ----------

export function draftedPositions(picks: MockPick[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const p of picks) {
    if (!p.position) continue;
    const arr = out.get(p.rosterId) ?? [];
    arr.push(p.position);
    out.set(p.rosterId, arr);
  }
  return out;
}

/** a roster's appetite by position given everything drafted so far */
export function needsFor(
  model: NeedModel,
  draft: MockDraft,
  rosterId: number,
  round: number,
): Record<string, number> {
  const drafted = draftedPositions(draft.picks);
  if (model.mode === "rookie") {
    const mult = { ...(model.base.get(rosterId) ?? {}) };
    // Each rookie taken at a position cools that appetite — nobody drafts four
    // rookie RBs because their roster was RB-poor in June.
    for (const pos of drafted.get(rosterId) ?? []) mult[pos] = (mult[pos] ?? 1) * 0.7;
    return mult;
  }
  return pickNeedMultipliers(model.league, draft.setup.rounds, round, drafted, [rosterId]).get(rosterId) ?? {};
}

// ---------- choosing ----------

/**
 * The slice of the board a drafter actually considers: the top of the board,
 * plus the best available player at any position they *must* fill (need ≥ 2,
 * e.g. a kicker in the last round) — that's a reach, and reaches happen.
 */
export function considerationPool(available: ConsensusRow[], need: Record<string, number>): ConsensusRow[] {
  const pool = available.slice(0, TOP_SLICE);
  for (const [pos, n] of Object.entries(need)) {
    if (n < 2 || pool.some((r) => r.position === pos)) continue;
    const best = available.find((r) => r.position === pos);
    if (best) pool.push(best);
  }
  return pool;
}

const TOP_SLICE = CONSIDERATION_SET + 4;

function weightsFor(pool: ConsensusRow[], need: Record<string, number>): number[] {
  return pool.map((row, i) => {
    // reaches (appended past the top slice) are judged on need alone
    const base = i < TOP_SLICE ? Math.exp(-i / TASTE_DECAY) : 1;
    const n = row.position ? (need[row.position] ?? 1) : 1;
    return base * n;
  });
}

/** stochastic CPU pick: taste-decayed, need-weighted sample from the top of the board */
export function cpuChoose(
  available: ConsensusRow[],
  need: Record<string, number>,
  rand: () => number,
): ConsensusRow | null {
  if (available.length === 0) return null;
  const pool = considerationPool(available, need);
  const weights = weightsFor(pool, need);
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return pool[0];
  let r = rand() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/** deterministic best pick for me: highest need-weighted taste, no dice */
export function greedyChoose(available: ConsensusRow[], need: Record<string, number>): ConsensusRow | null {
  if (available.length === 0) return null;
  const pool = considerationPool(available, need);
  const weights = weightsFor(pool, need);
  let best = 0;
  for (let i = 1; i < pool.length; i++) if (weights[i] > weights[best]) best = i;
  return pool[best];
}

export function pickRng(setup: MockSetup, pickNo: number): () => number {
  return mulberry32((setup.seed * 7919 + pickNo * 104729) | 0);
}

export function availableRows(board: ConsensusRow[], draft: MockDraft): ConsensusRow[] {
  const taken = new Set(draft.picks.map((p) => p.key));
  return board.filter((r) => !taken.has(r.key));
}

function toPick(slot: Slot, row: ConsensusRow, setup: MockSetup, auto: boolean): MockPick {
  return {
    ...slot,
    key: row.key,
    displayName: row.displayName,
    position: row.position,
    sleeperId: row.sleeperId,
    mine: slot.rosterId === setup.myRosterId,
    auto,
    real: false,
  };
}

/** record a pick for whoever is on the clock */
export function makePick(draft: MockDraft, row: ConsensusRow, auto = false): MockDraft {
  const slot = nextSlot(draft);
  if (!slot) return draft;
  if (draft.picks.some((p) => p.key === row.key)) return draft;
  return { ...draft, picks: [...draft.picks, toPick(slot, row, draft.setup, auto)] };
}

/**
 * Simulate CPU picks. With `untilMine`, stop when I'm on the clock; otherwise
 * auto-pick for me too (greedy) and run to the end of the draft.
 */
export function advance(
  draft: MockDraft,
  board: ConsensusRow[],
  model: NeedModel,
  untilMine: boolean,
): MockDraft {
  const picks = [...draft.picks];
  const taken = new Set(picks.map((p) => p.key));
  let cur: MockDraft = { ...draft, picks };
  for (;;) {
    const slot = slotAt(draft.setup, picks.length + 1);
    if (!slot) break;
    const mine = slot.rosterId === draft.setup.myRosterId;
    if (mine && untilMine) break;
    const available = board.filter((r) => !taken.has(r.key));
    const need = needsFor(model, cur, slot.rosterId, slot.round);
    const row = mine
      ? greedyChoose(available, need)
      : cpuChoose(available, need, pickRng(draft.setup, slot.pickNo));
    if (!row) break;
    picks.push(toPick(slot, row, draft.setup, true));
    taken.add(row.key);
    cur = { ...cur, picks };
  }
  return { ...draft, picks };
}

/** rewind to just before my most recent (non-real) pick; with none, drop every mock pick */
export function undoToMyLastPick(draft: MockDraft): MockDraft {
  let idx = -1;
  for (let i = draft.picks.length - 1; i >= 0; i--) {
    if (draft.picks[i].mine && !draft.picks[i].real) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return { ...draft, picks: draft.picks.filter((p) => p.real) };
  return { ...draft, picks: draft.picks.slice(0, idx) };
}

// ---------- results ----------

export interface TeamHaul {
  rosterId: number;
  picks: MockPick[];
  value: number;
}

/** every team's haul (mock picks only) ranked by summed value */
export function summarize(draft: MockDraft, valueOf: (pick: MockPick) => number): TeamHaul[] {
  const by = new Map<number, TeamHaul>();
  for (const rid of Object.values(draft.setup.slotToRoster)) by.set(rid, { rosterId: rid, picks: [], value: 0 });
  for (const p of draft.picks) {
    if (p.real) continue;
    const h = by.get(p.rosterId) ?? { rosterId: p.rosterId, picks: [], value: 0 };
    h.picks.push(p);
    h.value += valueOf(p);
    by.set(p.rosterId, h);
  }
  return [...by.values()]
    .map((h) => ({ ...h, value: Math.round(h.value) }))
    .sort((a, b) => b.value - a.value);
}

export interface MockAdp {
  avg: number;
  min: number;
  max: number;
  n: number;
}

export interface MockRun {
  seed: number;
  /** every pick of this timeline, base picks included */
  picks: MockPick[];
}

export interface BatchResult {
  runs: number;
  /** how many picks were already made when the batch started */
  startedAt: number;
  /** board key → overall-pick stats across runs (players never drafted are absent) */
  adp: Map<string, MockAdp>;
  /** my pick number → board key → how often he was still available there */
  availability: Map<number, Map<string, number>>;
  /** my picks still to come when the batch started */
  myPickNos: number[];
  timelines: MockRun[];
}

export interface BatchOptions {
  /** pick number → board key: force that pick in every run (decision conditioning) */
  forced?: Record<number, string>;
  /** how my un-forced picks are made: greedy (default) or sampled like a CPU */
  myPolicy?: "greedy" | "sample";
  /** how many board rows to tally availability for at each of my picks */
  tallyDepth?: number;
}

/**
 * Run `n` seeded mocks from the same starting point (base picks kept). Yields
 * a mock ADP for every board player, availability odds at each of my picks,
 * and every timeline's full pick list for roster/strength analysis.
 */
export function runMocks(
  base: MockDraft,
  board: ConsensusRow[],
  model: NeedModel,
  n: number,
  opts: BatchOptions = {},
): BatchResult {
  const adpAcc = new Map<string, { sum: number; min: number; max: number; n: number }>();
  const availability = new Map<number, Map<string, number>>();
  const myPickNos = myPickNumbers(base.setup).filter((p) => p > base.picks.length);
  for (const p of myPickNos) availability.set(p, new Map());
  const forced = opts.forced ?? {};
  const depth = opts.tallyDepth ?? 60;
  const timelines: MockRun[] = [];

  for (let run = 0; run < n; run++) {
    const setup = { ...base.setup, seed: (base.setup.seed + run * 1_000_003) | 0 };
    const picks = base.picks.slice();
    const taken = new Set(picks.map((p) => p.key));
    let cur: MockDraft = { setup, picks };
    for (;;) {
      const slot = slotAt(setup, picks.length + 1);
      if (!slot) break;
      const available = board.filter((r) => !taken.has(r.key));
      const mine = slot.rosterId === setup.myRosterId;
      if (mine) {
        const tally = availability.get(slot.pickNo);
        if (tally) for (const r of available.slice(0, depth)) tally.set(r.key, (tally.get(r.key) ?? 0) + 1);
      }
      const need = needsFor(model, cur, slot.rosterId, slot.round);
      const forcedKey = forced[slot.pickNo];
      const forcedRow = forcedKey ? available.find((r) => r.key === forcedKey) ?? null : null;
      const row =
        forcedRow ??
        (mine
          ? opts.myPolicy === "sample"
            ? cpuChoose(available, need, pickRng(setup, slot.pickNo))
            : greedyChoose(available, need)
          : cpuChoose(available, need, pickRng(setup, slot.pickNo)));
      if (!row) break;
      const acc = adpAcc.get(row.key) ?? { sum: 0, min: Infinity, max: 0, n: 0 };
      acc.sum += slot.pickNo;
      acc.min = Math.min(acc.min, slot.pickNo);
      acc.max = Math.max(acc.max, slot.pickNo);
      acc.n++;
      adpAcc.set(row.key, acc);
      picks.push(toPick(slot, row, setup, !forcedRow || !mine));
      taken.add(row.key);
      cur = { setup, picks };
    }
    timelines.push({ seed: setup.seed, picks });
  }

  const adp = new Map<string, MockAdp>();
  for (const [k, a] of adpAcc) adp.set(k, { avg: Math.round((a.sum / a.n) * 10) / 10, min: a.min, max: a.max, n: a.n });
  return { runs: n, startedAt: base.picks.length, adp, availability, myPickNos, timelines };
}

/** the top-k need-weighted choices for whoever is on the clock (candidates to compare) */
export function rankedChoices(available: ConsensusRow[], need: Record<string, number>, k: number): ConsensusRow[] {
  if (available.length === 0) return [];
  const pool = considerationPool(available, need);
  const weights = weightsFor(pool, need);
  return pool
    .map((row, i) => ({ row, w: weights[i] }))
    .sort((a, b) => b.w - a.w)
    .slice(0, k)
    .map((x) => x.row);
}
