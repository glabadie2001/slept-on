import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useAppData } from "../AppContext";
import { PosChip } from "../components";
import { normalizeName } from "../api/marketValues";
import { DRAFT_MODE_LABEL, MODE_VALUE_LABEL, defaultRounds, modeValue } from "../lib/draftMode";
import type { DraftMode } from "../lib/draftMode";
import type { ConsensusRow } from "../lib/guides";
import { optimizeLineup } from "../lib/lineup";
import {
  advance,
  availableRows,
  greedyChoose,
  makePick,
  myPickNumbers,
  needsFor,
  nextSlot,
  pickLabel,
  runMocks,
  setupFromSleeperDraft,
  slotAt,
  summarize,
  syntheticSetup,
  totalPicks,
  undoToMyLastPick,
} from "../lib/mockDraft";
import type { BatchResult, MockAdp, MockDraft as MockDraftState, MockPick, MockRun, MockSetup, NeedModel } from "../lib/mockDraft";
import {
  availabilityMatrix,
  pickTimelines,
  positionRuns,
  scoreTimelines,
  targetsAt,
  timelineRosters,
  typicalRoster,
  whatHadToGoRight,
} from "../lib/mockAnalysis";
import type { ScoredTimeline } from "../lib/mockAnalysis";
import { branchPoint, candidatesAt, compareCandidates, seasonFor } from "../lib/timelines";
import type { CandidateOutcome } from "../lib/timelines";
import { buildSeasonSchedule } from "../lib/simulator";
import type { SleeperDraft } from "../types";

const BATCH_RUNS = 200;
const RUNS_PER_CANDIDATE = 60;
const SEASON_SIMS = 400;

/** dataviz reference sequential blue, step 700 → 100 (dark surface: near-zero recedes into the page) */
const HEAT_RAMP = [
  "#0d366b", "#104281", "#184f95", "#1c5cab", "#256abf", "#2a78d6", "#3987e5",
  "#5598e7", "#6da7ec", "#86b6ef", "#9ec5f4", "#b7d3f6", "#cde2fb",
];
function heatStyle(pct: number): { background: string; color: string } {
  if (pct <= 0.02) return { background: "var(--surface-2)", color: "var(--muted)" };
  const idx = Math.min(HEAT_RAMP.length - 1, Math.floor(pct * HEAT_RAMP.length));
  return { background: HEAT_RAMP[idx], color: idx >= 7 ? "#0d0d0d" : "#ffffff" };
}

interface Props {
  mode: DraftMode;
  /** the board with real-draft picks (and, in rookie mode, rostered players) already removed */
  board: ConsensusRow[];
  /** picks already made in the real Sleeper draft, in order */
  realPicks: MockPick[];
  sleeperDraft: SleeperDraft | null;
  /** rookie mode: roster-derived appetite per roster_id */
  needBase: Map<number, Record<string, number>>;
  positions: string[];
  /** batch mock ADP for the consensus board (null when cleared) */
  onAdp?: (adp: Map<string, MockAdp> | null) => void;
}

type BatchView = "board" | "runs" | "rosters" | "timelines";

/**
 * Interactive mock draft on top of the consensus board. CPU teams draft with
 * the same need-weighted taste model the survival odds use; you pick when
 * you're on the clock (or let the engine pick for you). If a Sleeper draft is
 * in progress, the mock continues from the real picks. The batch tools run
 * hundreds of seeded timelines from wherever the mock currently stands.
 */
export function MockDraft({ mode, board, realPicks, sleeperDraft, needBase, positions, onAdp }: Props) {
  const { bundle, teams, myTeam, values, projPts } = useAppData();
  const byRoster = useMemo(() => new Map(teams.map((t) => [t.rosterId, t])), [teams]);
  const rosterIds = useMemo(() => bundle.rosters.map((r) => r.roster_id), [bundle.rosters]);
  const myRosterId = myTeam?.rosterId ?? null;

  // A live/pre-draft Sleeper draft with an order fixes slots and seeds the mock
  // with its real picks; a finished (or missing) one means we invent an order.
  const useReal = !!sleeperDraft?.slot_to_roster_id && sleeperDraft.status !== "complete";

  const [rounds, setRounds] = useState(() => defaultRounds(mode, bundle.league, useReal ? sleeperDraft : null));
  const [type, setType] = useState<"snake" | "linear">(sleeperDraft?.type === "linear" ? "linear" : "snake");
  const [mySlot, setMySlot] = useState(() => Math.ceil(rosterIds.length / 2));
  const [seed, setSeed] = useState(1);
  const [draft, setDraft] = useState<MockDraftState | null>(null);
  const [posFilter, setPosFilter] = useState("ALL");
  const [search, setSearch] = useState("");

  // batch state
  const [batch, setBatch] = useState<BatchResult | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [view, setView] = useState<BatchView>("board");
  const [outcomes, setOutcomes] = useState<CandidateOutcome[] | null>(null);
  const [tlBusy, setTlBusy] = useState(false);
  const [extraCandidate, setExtraCandidate] = useState<string>("");
  const [openRoster, setOpenRoster] = useState<string | null>(null);

  const clearBatch = () => {
    setBatch(null);
    setOutcomes(null);
    onAdp?.(null);
  };

  // Mode changes reset the round default (rookie 4 vs full roster) and any running mock.
  useEffect(() => {
    setRounds(defaultRounds(mode, bundle.league, useReal ? sleeperDraft : null));
    setDraft(null);
    clearBatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const setup: MockSetup = useMemo(() => {
    if (useReal && sleeperDraft) {
      const s = setupFromSleeperDraft(sleeperDraft, bundle.tradedPicks, myRosterId, seed, rounds);
      if (s) return s;
    }
    return syntheticSetup(rosterIds, myRosterId, mySlot, rounds, type, bundle.league.season, seed);
  }, [useReal, sleeperDraft, bundle.tradedPicks, bundle.league.season, myRosterId, seed, rounds, rosterIds, mySlot, type]);

  const model: NeedModel = useMemo(
    () => ({ mode, league: bundle.league, base: needBase }),
    [mode, bundle.league, needBase],
  );

  const valueOf = (p: MockPick): number => modeValue(mode, p.sleeperId ? values[p.sleeperId] : null) ?? 0;
  const rowValue = (r: ConsensusRow): number | null => modeValue(mode, r.sleeperId ? values[r.sleeperId] : null);
  const valueLabel = MODE_VALUE_LABEL[mode].toLowerCase();

  // How a timeline's roster is scored: projected starter points where the draft
  // builds the whole roster; summed dynasty value for a rookie draft, where four
  // rookies barely move a season projection.
  const seasonMode = mode !== "rookie";
  const scoreRoster = useMemo(
    () =>
      seasonMode
        ? (ids: string[]) => optimizeLineup(bundle.league, ids, bundle.players, projPts).totalProjected
        : (ids: string[]) => Math.round(ids.reduce((s, id) => s + (values[id]?.value ?? 0), 0)),
    [seasonMode, bundle.league, bundle.players, projPts, values],
  );
  const baseRosters = useMemo(
    () => (mode === "rookie" ? new Map(bundle.rosters.map((r) => [r.roster_id, r.players ?? []])) : new Map<number, string[]>()),
    [mode, bundle.rosters],
  );
  const scoreLabel = seasonMode ? "proj. starters" : "roster value";

  const start = () => {
    clearBatch();
    setDraft(advance({ setup, picks: useReal ? realPicks : [] }, board, model, true));
  };
  const reseed = () => {
    setSeed((s) => s + 1);
    setDraft(null);
    clearBatch();
  };

  const onClock = draft ? nextSlot(draft) : null;
  const myTurn = !!onClock && onClock.rosterId === myRosterId;
  const available = useMemo(() => (draft ? availableRows(board, draft) : board), [board, draft]);
  // the engine stops when the board runs dry — say so instead of showing a stuck clock
  const exhausted = !!draft && !!onClock && available.length === 0;
  const finished = !!draft && (!onClock || exhausted);
  const myNeed = useMemo(
    () => (draft && onClock ? needsFor(model, draft, onClock.rosterId, onClock.round) : {}),
    [draft, onClock, model],
  );
  const suggestion = myTurn ? greedyChoose(available, myNeed) : null;

  const pickRow = (row: ConsensusRow) => {
    if (!draft || !myTurn) return;
    setDraft(advance(makePick(draft, row), board, model, true));
    setSearch("");
  };
  const autoPick = () => {
    if (!draft || !suggestion) return;
    setDraft(advance(makePick(draft, suggestion, true), board, model, true));
  };
  const simToEnd = () => draft && setDraft(advance(draft, board, model, false));
  const undo = () => draft && setDraft(undoToMyLastPick(draft));

  // ---- batch: from wherever the mock stands (or from the real picks) ----
  const batchBase: MockDraftState = useMemo(
    () => draft ?? { setup, picks: useReal ? realPicks : [] },
    [draft, setup, useReal, realPicks],
  );
  const runBatch = () => {
    setBatchBusy(true);
    setTimeout(() => {
      const res = runMocks(batchBase, board, model, BATCH_RUNS);
      setBatch(res);
      onAdp?.(res.adp);
      setBatchBusy(false);
    }, 10);
  };

  const listed = useMemo(() => {
    let rows = available;
    if (posFilter !== "ALL") rows = rows.filter((r) => r.position === posFilter);
    if (search.trim()) {
      const q = normalizeName(search);
      rows = rows.filter((r) => r.key.includes(q));
    }
    return rows.slice(0, 24);
  }, [available, posFilter, search]);

  const hauls = useMemo(() => (draft ? summarize(draft, valueOf) : []), [draft, values, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const myHaul = hauls.find((h) => h.rosterId === myRosterId);
  const myHaulRank = myHaul ? hauls.indexOf(myHaul) + 1 : null;

  const myPickNos = useMemo(() => myPickNumbers(setup), [setup]);
  const teamName = (rid: number) => byRoster.get(rid)?.teamName ?? `Roster ${rid}`;

  // ---- batch read-outs ----
  const heat = useMemo(() => (batch ? availabilityMatrix(batch, board, 40, 8) : null), [batch, board]);
  const runs = useMemo(() => (batch ? positionRuns(batch, positions.filter((p) => p !== "K" && p !== "DEF"), [1, 3, 6, 9, 12, 18, 24]) : null), [batch, positions]);
  const typical = useMemo(() => (batch ? typicalRoster(batch, myRosterId) : null), [batch, myRosterId]);
  const scored = useMemo(
    () => (batch ? scoreTimelines(batch, rosterIds, myRosterId, baseRosters, scoreRoster) : null),
    [batch, rosterIds, myRosterId, baseRosters, scoreRoster],
  );
  const picked = useMemo(() => (scored ? pickTimelines(scored) : null), [scored]);

  // ---- Doctor Strange: candidates at my next pick ----
  const branch = useMemo(() => branchPoint(batchBase, board, model), [batchBase, board, model]);
  const branchSlot = branch ? nextSlot(branch) : null;
  const defaultCandidates = useMemo(() => (branch ? candidatesAt(branch, board, model, 3) : []), [branch, board, model]);
  const branchAvailable = useMemo(() => (branch ? availableRows(board, branch) : []), [branch, board]);
  const candidates = useMemo(() => {
    const extra = extraCandidate ? branchAvailable.find((r) => r.key === extraCandidate) : null;
    return extra && !defaultCandidates.some((c) => c.key === extra.key) ? [...defaultCandidates, extra] : defaultCandidates;
  }, [defaultCandidates, branchAvailable, extraCandidate]);

  const runTimelines = () => {
    if (!branch || candidates.length === 0) return;
    setTlBusy(true);
    setTimeout(() => {
      const season = seasonMode
        ? seasonFor(
            rosterIds,
            buildSeasonSchedule(bundle).games,
            (bundle.league.settings.playoff_week_start ?? 15) - 1,
            bundle.league.settings.playoff_teams ?? 6,
            SEASON_SIMS,
            seed * 31 + 7,
          )
        : null;
      setOutcomes(
        compareCandidates({
          base: branch,
          board,
          model,
          candidates,
          runsPerCandidate: RUNS_PER_CANDIDATE,
          rosterIds,
          baseRosters,
          scoreRoster,
          season,
        }),
      );
      setTlBusy(false);
    }, 10);
  };

  if (board.length === 0) {
    return (
      <div className="card section">
        <h2>Mock draft</h2>
        <p className="muted">Load at least one guide — the mock drafts off your consensus board.</p>
      </div>
    );
  }

  const fmtPct = (p: number) => `${Math.round(p * 100)}%`;
  const fromLabel = batchBase.picks.length > 0 ? `from pick ${batchBase.picks.length + 1}` : "from pick 1";

  /** one timeline's roster for a team, in lineup slots (season modes) or as a value list (rookie) */
  const RosterView = ({ run, rosterId, title, note }: { run: MockRun; rosterId: number; title: ReactNode; note?: ReactNode }) => {
    const ids = timelineRosters(run, rosterIds, baseRosters).get(rosterId) ?? [];
    const drafted = new Set(run.picks.filter((p) => p.rosterId === rosterId && p.pickNo > (batch?.startedAt ?? 0)).map((p) => p.sleeperId));
    if (seasonMode) {
      const lineup = optimizeLineup(bundle.league, ids, bundle.players, projPts);
      const starters = new Set(lineup.slots.map((s) => s.playerId).filter(Boolean));
      const bench = ids.filter((id) => !starters.has(id));
      return (
        <div className="tl-roster">
          <h3>{title}</h3>
          {note && <p className="muted small">{note}</p>}
          <table className="lineup-mini">
            <tbody>
              {lineup.slots.map((s, i) => {
                const p = s.playerId ? bundle.players[s.playerId] : null;
                return (
                  <tr key={i} className={s.playerId && drafted.has(s.playerId) ? "" : "muted"}>
                    <td className="slot"><PosChip pos={s.slot} /></td>
                    <td>{p ? p.full_name ?? s.playerId : <span className="muted">—</span>}</td>
                    <td className="right num muted">{s.projected ? s.projected.toFixed(1) : ""}</td>
                  </tr>
                );
              })}
              <tr>
                <td colSpan={2} className="muted small">bench: {bench.map((id) => bundle.players[id]?.full_name ?? id).join(", ") || "—"}</td>
                <td className="right num"><strong>{lineup.totalProjected}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
      );
    }
    const mine = run.picks.filter((p) => p.rosterId === rosterId && p.pickNo > (batch?.startedAt ?? 0));
    return (
      <div className="tl-roster">
        <h3>{title}</h3>
        {note && <p className="muted small">{note}</p>}
        <ul className="advice-list">
          {mine.map((p) => (
            <li key={p.pickNo}>
              <span className="icon num muted">{pickLabel(p)}</span>
              <span>
                <strong>{p.displayName}</strong> {p.position && <PosChip pos={p.position} />}{" "}
                <span className="muted small">value {Math.round(valueOf(p))}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="muted small">roster value incl. existing players: <strong>{scoreRoster(ids)}</strong></p>
      </div>
    );
  };

  const timelineCard = (t: ScoredTimeline, label: string) => {
    const lucky = batch ? whatHadToGoRight(t.run, batch, myRosterId) : [];
    return (
      <div className="card" key={label}>
        <RosterView
          run={t.run}
          rosterId={myRosterId ?? rosterIds[0]}
          title={`${label} · ${scoreLabel} ${seasonMode ? t.myScore.toFixed(1) : t.myScore} · #${t.myRank} of ${rosterIds.length}`}
          note={
            lucky.length > 0 ? (
              <>
                What had to go right:{" "}
                {lucky.map((l, i) => (
                  <span key={l.pick.key}>
                    {i > 0 && " · "}
                    {l.pick.displayName} at {pickLabel(l.pick)} <span className="num">({fmtPct(l.pct)} available)</span>
                  </span>
                ))}
              </>
            ) : (
              "Nothing unusual had to fall — every pick here was available at least half the time."
            )
          }
        />
      </div>
    );
  };

  return (
    <div className="card section">
      <h2>Mock draft</h2>
      <p className="muted small">
        {DRAFT_MODE_LABEL[mode]} · CPU teams pick from the top of your consensus board with need-weighted,
        decaying taste (the same model behind the "Lasts %" column); you pick when you're up.
        {useReal && realPicks.length > 0 && ` Continues from the ${realPicks.length} picks already made on Sleeper.`}
        {useReal && realPicks.length === 0 && " Uses the real Sleeper draft order."}
        {!useReal && " No live Sleeper order — pick your slot and the rest is shuffled."}
      </p>

      <div className="pill-row" style={{ alignItems: "center" }}>
        {!useReal && (
          <>
            <label className="muted small">
              slot{" "}
              <select value={mySlot} onChange={(e) => { setMySlot(Number(e.target.value)); setDraft(null); clearBatch(); }}>
                {rosterIds.map((_, i) => (
                  <option key={i + 1} value={i + 1}>#{i + 1}</option>
                ))}
              </select>
            </label>
            <button className={type === "snake" ? "active" : ""} onClick={() => { setType(type === "snake" ? "linear" : "snake"); setDraft(null); clearBatch(); }}>
              {type}
            </button>
          </>
        )}
        <label className="muted small">
          rounds{" "}
          <input
            type="number"
            min={1}
            max={30}
            value={rounds}
            onChange={(e) => { setRounds(Math.max(1, Math.min(30, Number(e.target.value) || 1))); setDraft(null); clearBatch(); }}
            style={{ width: 56 }}
          />
        </label>
        <span className="muted small">seed {seed}</span>
        <button onClick={reseed} title="New random CPU behaviour">🎲 reseed</button>
        {!draft && <button className="active" onClick={start}>▶ Start mock</button>}
        {draft && <button onClick={start}>↺ Restart</button>}
        <button onClick={runBatch} disabled={batchBusy} title={`Run ${BATCH_RUNS} seeded mocks ${fromLabel}, greedy picks for you`}>
          {batchBusy ? "⏳ running…" : `📊 Run ${BATCH_RUNS} mocks ${fromLabel}`}
        </button>
      </div>

      {draft && (
        <>
          <div className={`mock-status${myTurn ? " mine" : ""}`}>
            {exhausted ? (
              <span>
                <strong>Board exhausted after {draft.picks.length} picks</strong>{" "}
                <span className="muted small">— {totalPicks(setup)} needed; load deeper guides to mock the whole draft</span>
              </span>
            ) : finished ? (
              <strong>Draft complete — {totalPicks(setup)} picks.</strong>
            ) : onClock ? (
              <span>
                <strong>Pick {onClock.pickNo}</strong> ({pickLabel(onClock)}) —{" "}
                {myTurn ? <strong style={{ color: "var(--delta-up)" }}>you're on the clock</strong> : teamName(onClock.rosterId)}
              </span>
            ) : null}
            <span className="spacer" />
            {myTurn && suggestion && (
              <button className="active" onClick={autoPick} title="Best need-weighted pick per the engine">
                🤖 Auto-pick {suggestion.displayName}
              </button>
            )}
            {!finished && <button onClick={simToEnd}>⏩ Sim to end</button>}
            {draft.picks.some((p) => p.mine && !p.real) && <button onClick={undo}>↶ Undo my last pick</button>}
          </div>

          {myTurn && (
            <>
              <div className="board-controls">
                <div className="pill-row" style={{ marginBottom: 0 }}>
                  {["ALL", ...positions].map((p) => (
                    <button key={p} className={posFilter === p ? "active" : ""} onClick={() => setPosFilter(p)}>
                      {p}
                      {p !== "ALL" && myNeed[p] != null && (
                        <span className="muted small"> {myNeed[p] >= 1.3 ? "▲" : myNeed[p] <= 0.5 ? "▽" : ""}</span>
                      )}
                    </button>
                  ))}
                </div>
                <input type="text" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 180 }} />
              </div>
              <div className="pick-list">
                {listed.map((r) => {
                  const v = rowValue(r);
                  const adp = batch?.adp.get(r.key);
                  const avail = onClock && batch?.availability.get(onClock.pickNo)?.get(r.key);
                  return (
                    <div key={r.key} className="pick-row">
                      <span className="rank num">#{r.consensus}</span>
                      {r.position ? <PosChip pos={r.position} /> : <span className="pos-chip pos-FLEX">?</span>}
                      <span className="who">
                        {r.displayName}
                        {suggestion?.key === r.key && <span className="muted small"> · engine's pick</span>}
                      </span>
                      <span className="meta num">
                        {v != null ? `${valueLabel} ${v}` : ""}
                        {adp ? ` · ADP ${adp.avg}` : ""}
                        {avail != null && batch ? ` · here ${fmtPct(avail / batch.runs)}` : ""}
                      </span>
                      <button onClick={() => pickRow(r)}>Draft</button>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <h3 style={{ marginTop: 14 }}>Board</h3>
          <div className="table-wrap">
            <table className="mock-grid">
              <thead>
                <tr>
                  <th>Rd</th>
                  {Array.from({ length: setup.teams }, (_, i) => i + 1).map((slot) => {
                    const rid = setup.slotToRoster[String(slot)];
                    return (
                      <th key={slot} className={`team${rid === myRosterId ? " mine" : ""}`} title={teamName(rid)}>
                        {slot}. {teamName(rid)}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: setup.rounds }, (_, r) => r + 1).map((round) => (
                  <tr key={round}>
                    <td className="muted num">{round}</td>
                    {Array.from({ length: setup.teams }, (_, i) => i + 1).map((slot) => {
                      const pickNo = setup.type === "snake" && round % 2 === 0
                        ? (round - 1) * setup.teams + (setup.teams - slot + 1)
                        : (round - 1) * setup.teams + slot;
                      const owner = slotAt(setup, pickNo);
                      const p = draft.picks[pickNo - 1];
                      const mine = owner?.rosterId === myRosterId;
                      const traded = owner && owner.rosterId !== setup.slotToRoster[String(slot)];
                      return (
                        <td
                          key={slot}
                          className={`${mine ? "mine" : ""}${p?.real ? " real" : ""}${!p ? " empty" : ""}`}
                          title={p ? `${p.displayName} → ${teamName(p.rosterId)}${traded ? " (traded pick)" : ""}` : traded ? `pick owned by ${teamName(owner!.rosterId)}` : ""}
                        >
                          {p ? (
                            <>
                              {p.position && <PosChip pos={p.position} />} <span className="cell-name">{p.displayName}</span>
                            </>
                          ) : onClock?.pickNo === pickNo ? (
                            <span className="muted">⏱</span>
                          ) : (
                            "·"
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {myHaul && myHaul.picks.length > 0 && (
            <div className="grid cols-2" style={{ marginTop: 14 }}>
              <div>
                <h3>Your haul</h3>
                <ul className="advice-list">
                  {myHaul.picks.map((p) => (
                    <li key={p.pickNo}>
                      <span className="icon num muted">{pickLabel(p)}</span>
                      <span>
                        <strong>{p.displayName}</strong> {p.position && <PosChip pos={p.position} />}{" "}
                        <span className="muted small">
                          {valueLabel} {Math.round(valueOf(p))}
                          {p.auto ? " · auto" : ""}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>Hauls by {valueLabel} value</h3>
                <p className="muted small">
                  {finished
                    ? `Your ${myHaul.picks.length} picks rank #${myHaulRank} of ${hauls.length} by summed ${valueLabel} value — a rough scorecard, not a grade.`
                    : "Updates as the mock proceeds."}
                </p>
                <ul className="advice-list">
                  {hauls.slice(0, 6).map((h, i) => (
                    <li key={h.rosterId}>
                      <span className="icon num muted">#{i + 1}</span>
                      <span>
                        {h.rosterId === myRosterId ? <strong>{teamName(h.rosterId)}</strong> : teamName(h.rosterId)}{" "}
                        <span className="muted small num">{h.value} · {h.picks.length} picks</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </>
      )}

      {/* ---------- batch read-outs ---------- */}
      {batch && heat && runs && typical && scored && picked && (
        <div style={{ marginTop: 16 }}>
          <div className="board-controls">
            <div className="pill-row" style={{ marginBottom: 0 }}>
              {(
                [
                  ["board", "Where the board falls"],
                  ["runs", "Positional runs"],
                  ["rosters", "Your rosters"],
                  ["timelines", "Timelines"],
                ] as [BatchView, string][]
              ).map(([id, label]) => (
                <button key={id} className={view === id ? "active" : ""} onClick={() => setView(id)}>
                  {label}
                </button>
              ))}
            </div>
            <span className="muted small">
              {batch.runs} timelines · started at pick {batch.startedAt + 1} · mock ADP is now a column on the consensus board
            </span>
          </div>

          {view === "board" && (
            <>
              <h3>Who's still there at each of your picks</h3>
              <p className="muted small">
                Share of {batch.runs} timelines in which the player was on the board when you picked. Darker = gone.
                Watch for the row where a column flips — that's the tier cliff between two of your picks.
              </p>
              <div className="table-wrap">
                <table className="heat">
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th className="right">Rank</th>
                      <th className="right">ADP</th>
                      {heat.picks.map((p) => (
                        <th key={p} className="center" title={`your pick #${p}`}>
                          #{p}
                          <div className="muted small">{pickLabel(slotAt(setup, p)!)}</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {heat.rows.map(({ row, pct }) => {
                      const adp = batch.adp.get(row.key);
                      return (
                        <tr key={row.key}>
                          <td>
                            <span className="player-cell">
                              {row.position ? <PosChip pos={row.position} /> : <span className="pos-chip pos-FLEX">?</span>}
                              <span className="cell-name" style={{ maxWidth: 160 }}>{row.displayName}</span>
                            </span>
                          </td>
                          <td className="right num muted">{row.consensus}</td>
                          <td className="right num muted" title={adp ? `range ${adp.min}–${adp.max}` : "never drafted"}>
                            {adp ? adp.avg : "—"}
                          </td>
                          {pct.map((v, i) => (
                            <td key={i} className="center num heat-cell" style={heatStyle(v)} title={`${row.displayName}: ${fmtPct(v)} available at pick #${heat.picks[i]}`}>
                              {Math.round(v * 100)}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="heat-legend muted small">
                <span>available:</span>
                {[0, 0.25, 0.5, 0.75, 1].map((v) => (
                  <span key={v} className="swatch num" style={heatStyle(v)}>{Math.round(v * 100)}%</span>
                ))}
              </div>

              <h3 style={{ marginTop: 16 }}>Realistic targets at each pick</h3>
              <p className="muted small">
                Ranked by {valueLabel} value × availability — the best player you can actually expect, not the best
                player who might fall. Only options on the board at least 20% of the time.
              </p>
              <div className="table-wrap">
                <table className="fall-table">
                  <thead>
                    <tr>
                      <th>Your pick</th>
                      <th>Targets</th>
                    </tr>
                  </thead>
                  <tbody>
                    {heat.picks.map((pickNo) => {
                      const targets = targetsAt(batch, pickNo, board, rowValue, 6);
                      return (
                        <tr key={pickNo}>
                          <td className="num">
                            <strong>#{pickNo}</strong> <span className="muted small">{pickLabel(slotAt(setup, pickNo)!)}</span>
                          </td>
                          <td className="names">
                            {targets.length === 0 && <span className="muted">—</span>}
                            <div className="target-list">
                              {targets.map((t) => (
                                <span key={t.row.key} className="target" title={`${valueLabel} ${Math.round(t.value)} × ${fmtPct(t.pct)} available`}>
                                  {t.row.position && <PosChip pos={t.row.position} />} {t.row.displayName}{" "}
                                  <span className="muted num small">{fmtPct(t.pct)}</span>
                                  <span className="target-bar"><span style={{ width: `${Math.round(t.pct * 100)}%` }} /></span>
                                </span>
                              ))}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {view === "runs" && (
            <>
              <h3>When positions go</h3>
              <p className="muted small">
                Median pick at which the Nth player at each position left the board. If the 6th RB usually goes
                before your second pick, that's when you need one.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Position</th>
                      {[1, 3, 6, 9, 12, 18, 24].map((n) => (
                        <th key={n} className="right">{n}{n === 1 ? "st" : n === 3 ? "rd" : "th"}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => (
                      <tr key={r.position}>
                        <td><PosChip pos={r.position} /></td>
                        {r.median.map((m, i) => (
                          <td key={i} className="right num">
                            {m == null ? <span className="muted">—</span> : (
                              <>
                                {m} <span className="muted small">{pickLabel(slotAt(setup, m) ?? { round: 0, slot: 0 })}</span>
                              </>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted small" style={{ marginTop: 8 }}>
                Your picks: {myPickNos.filter((p) => p > batch.startedAt).map((p) => `#${p}`).join(", ")}
              </p>
            </>
          )}

          {view === "rosters" && (
            <>
              <h3>Your typical roster</h3>
              <p className="muted small">
                Who lands in each of your slots most often across {batch.runs} timelines, with greedy picks for you.
              </p>
              <div className="table-wrap">
                <table className="fall-table">
                  <thead>
                    <tr>
                      <th>Pick</th>
                      <th>Usually</th>
                      <th>Otherwise</th>
                    </tr>
                  </thead>
                  <tbody>
                    {typical.slots.map((s) => (
                      <tr key={s.pickNo}>
                        <td className="num">
                          <strong>#{s.pickNo}</strong> <span className="muted small">{pickLabel(slotAt(setup, s.pickNo)!)}</span>
                        </td>
                        <td>
                          {s.options[0] && (
                            <>
                              {s.options[0].position && <PosChip pos={s.options[0].position} />} <strong>{s.options[0].displayName}</strong>{" "}
                              <span className="muted num small">{fmtPct(s.options[0].pct)}</span>
                            </>
                          )}
                        </td>
                        <td className="names small">
                          {s.options.slice(1).map((o, i) => (
                            <span key={o.key}>
                              {i > 0 && <span className="muted"> · </span>}
                              {o.displayName} <span className="muted num">{fmtPct(o.pct)}</span>
                            </span>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted small" style={{ marginTop: 8 }}>
                Position mix: {typical.mix.map((m) => `${m.label} (${fmtPct(m.pct)})`).join(" · ")}
              </p>

              <h3 style={{ marginTop: 16 }}>Best, median and worst timelines</h3>
              {seasonMode && picked.best.myScore === 0 && (
                <p className="muted small">
                  ⚠ Every timeline projects 0 starter points — this board has no players with projections (e.g. an
                  incoming rookie class with no NFL stats). Switch the draft type to rookie, or load a veteran board.
                </p>
              )}
              <p className="muted small">
                Ranked by {scoreLabel}{seasonMode ? " (optimal lineup under your league's slots and scoring; offseason projections fall back to last season)" : " (dynasty value of the whole roster after the draft)"}.
                Greyed starters were already yours before the draft.
              </p>
              <div className="grid cols-3">
                {timelineCard(picked.best, "Best")}
                {timelineCard(picked.median, "Median")}
                {timelineCard(picked.worst, "Worst")}
              </div>
            </>
          )}

          {view === "timelines" && (
            <>
              <h3>Timelines by your next pick</h3>
              {!branch || !branchSlot ? (
                <p className="muted">You have no picks left from here.</p>
              ) : (
                <>
                  <p className="muted small">
                    Branch at <strong>pick #{branchSlot.pickNo}</strong> ({pickLabel(branchSlot)}): each candidate is forced there, then{" "}
                    {RUNS_PER_CANDIDATE} futures play out with greedy picks for you afterwards. Compare the distributions of your{" "}
                    {scoreLabel}
                    {seasonMode ? `; playoff and title odds come from ${SEASON_SIMS} simulated seasons of each candidate's median timeline` : "; rookie drafts skip season sims, four rookies don't move a season projection"}.
                    The differences are the decision; the spread inside each column is the dice.
                  </p>
                  <div className="pill-row" style={{ alignItems: "center" }}>
                    {candidates.map((c) => (
                      <span key={c.key} className="guide-chip">
                        {c.position && <PosChip pos={c.position} />} <strong>{c.displayName}</strong>
                        <span className="muted small"> · #{c.consensus}</span>
                      </span>
                    ))}
                    <select value={extraCandidate} onChange={(e) => setExtraCandidate(e.target.value)} title="Add a fourth candidate">
                      <option value="">+ add a candidate…</option>
                      {branchAvailable.slice(0, 30).filter((r) => !defaultCandidates.some((c) => c.key === r.key)).map((r) => (
                        <option key={r.key} value={r.key}>#{r.consensus} {r.displayName} ({r.position ?? "?"})</option>
                      ))}
                    </select>
                    <button className="active" onClick={runTimelines} disabled={tlBusy}>
                      {tlBusy ? "⏳ running futures…" : `🔮 Run ${candidates.length} × ${RUNS_PER_CANDIDATE} futures`}
                    </button>
                  </div>
                  {outcomes && outcomes.length > 0 && seasonMode && outcomes.every((o) => o.score.p90 === 0) && (
                    <p className="muted small">
                      ⚠ Every future projects 0 starter points, so the odds below are coin flips — this board has no
                      players with projections. Switch the draft type to rookie, or load a veteran board.
                    </p>
                  )}
                  {outcomes && outcomes.length > 0 && (() => {
                    const lo = Math.min(...outcomes.map((o) => o.score.p10));
                    const hi = Math.max(...outcomes.map((o) => o.score.p90));
                    const span = Math.max(1e-6, hi - lo);
                    const bestMedian = Math.max(...outcomes.map((o) => o.score.median));
                    const fmtScore = (v: number) => (seasonMode ? v.toFixed(1) : String(Math.round(v)));
                    return (
                      <>
                        <div className="table-wrap">
                          <table className="tl-table">
                            <thead>
                              <tr>
                                <th>Take at #{branchSlot.pickNo}</th>
                                <th>{scoreLabel} p10 · median · p90</th>
                                <th className="right">Avg rank</th>
                                <th className="right" title="share of futures where your roster ranks in the league's top third">Top ⅓</th>
                                {seasonMode && <th className="right">Playoffs</th>}
                                {seasonMode && <th className="right">Title</th>}
                                <th />
                              </tr>
                            </thead>
                            <tbody>
                              {outcomes.map((o) => (
                                <tr key={o.row.key} className={o.score.median === bestMedian ? "mine" : ""}>
                                  <td>
                                    {o.row.position && <PosChip pos={o.row.position} />} <strong>{o.row.displayName}</strong>{" "}
                                    <span className="muted small">#{o.row.consensus}</span>
                                  </td>
                                  <td>
                                    <div className="range-row">
                                      <span className="num muted small">{fmtScore(o.score.p10)}</span>
                                      <span className="range-bar" title={`p10 ${fmtScore(o.score.p10)} · median ${fmtScore(o.score.median)} · p90 ${fmtScore(o.score.p90)}`}>
                                        <span
                                          className="range-fill"
                                          style={{ left: `${((o.score.p10 - lo) / span) * 100}%`, width: `${Math.max(2, ((o.score.p90 - o.score.p10) / span) * 100)}%` }}
                                        />
                                        <span className="range-mid" style={{ left: `${((o.score.median - lo) / span) * 100}%` }} />
                                      </span>
                                      <span className="num"><strong>{fmtScore(o.score.median)}</strong></span>
                                      <span className="num muted small">{fmtScore(o.score.p90)}</span>
                                    </div>
                                  </td>
                                  <td className="right num">{o.avgRank.toFixed(1)}</td>
                                  <td className="right num">{fmtPct(o.topThirdPct)}</td>
                                  {seasonMode && <td className="right num">{o.odds ? `${Math.round(o.odds.playoffPct)}%` : "—"}</td>}
                                  {seasonMode && <td className="right num">{o.odds ? `${Math.round(o.odds.titlePct)}%` : "—"}</td>}
                                  <td className="right">
                                    <button className="linklike small" onClick={() => setOpenRoster(openRoster === o.row.key ? null : o.row.key)}>
                                      {openRoster === o.row.key ? "hide" : "median roster"}
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {outcomes.filter((o) => o.row.key === openRoster).map((o) => (
                          <div className="grid cols-2" style={{ marginTop: 10 }} key={o.row.key}>
                            <div className="card">
                              <RosterView
                                run={o.median.run}
                                rosterId={myRosterId ?? rosterIds[0]}
                                title={`Median future after ${o.row.displayName}`}
                                note={`${scoreLabel} ${fmtScore(o.median.myScore)} · #${o.median.myRank} of ${rosterIds.length}`}
                              />
                            </div>
                            <div className="card">
                              <RosterView
                                run={o.best.run}
                                rosterId={myRosterId ?? rosterIds[0]}
                                title={`Best future after ${o.row.displayName}`}
                                note={`${scoreLabel} ${fmtScore(o.best.myScore)} · #${o.best.myRank} of ${rosterIds.length}`}
                              />
                            </div>
                          </div>
                        ))}
                        <p className="muted small" style={{ marginTop: 8 }}>
                          Highlighted row = best median. If two rows overlap across most of their range, the pick doesn't
                          matter as much as it feels like it does.
                        </p>
                      </>
                    );
                  })()}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
