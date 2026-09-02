import { useEffect, useMemo, useState } from "react";
import { useAppData } from "../AppContext";
import { PosChip } from "../components";
import { normalizeName } from "../api/marketValues";
import { DRAFT_MODE_LABEL, MODE_VALUE_LABEL, defaultRounds, modeValue } from "../lib/draftMode";
import type { DraftMode } from "../lib/draftMode";
import type { ConsensusRow } from "../lib/guides";
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
import type { BatchResult, MockDraft as MockDraftState, MockPick, MockSetup, NeedModel } from "../lib/mockDraft";
import type { SleeperDraft } from "../types";

const BATCH_RUNS = 200;

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
}

/**
 * Interactive mock draft on top of the consensus board. CPU teams draft with
 * the same need-weighted taste model the survival odds use; you pick when
 * you're on the clock (or let the engine pick for you). If a Sleeper draft is
 * in progress, the mock continues from the real picks.
 */
export function MockDraft({ mode, board, realPicks, sleeperDraft, needBase, positions }: Props) {
  const { bundle, teams, myTeam, values } = useAppData();
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
  const [batch, setBatch] = useState<BatchResult | null>(null);
  const [posFilter, setPosFilter] = useState("ALL");
  const [search, setSearch] = useState("");

  // Mode changes reset the round default (rookie 4 vs full roster) and any running mock.
  useEffect(() => {
    setRounds(defaultRounds(mode, bundle.league, useReal ? sleeperDraft : null));
    setDraft(null);
    setBatch(null);
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

  const start = () => {
    setBatch(null);
    setDraft(advance({ setup, picks: useReal ? realPicks : [] }, board, model, true));
  };
  const reseed = () => {
    setSeed((s) => s + 1);
    setDraft(null);
    setBatch(null);
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

  const runBatch = () => {
    const base: MockDraftState = { setup, picks: useReal ? realPicks : [] };
    setBatch(runMocks(base, board, model, BATCH_RUNS));
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

  if (board.length === 0) {
    return (
      <div className="card section">
        <h2>Mock draft</h2>
        <p className="muted">Load at least one guide — the mock drafts off your consensus board.</p>
      </div>
    );
  }

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
              <select value={mySlot} onChange={(e) => { setMySlot(Number(e.target.value)); setDraft(null); setBatch(null); }}>
                {rosterIds.map((_, i) => (
                  <option key={i + 1} value={i + 1}>#{i + 1}</option>
                ))}
              </select>
            </label>
            <button className={type === "snake" ? "active" : ""} onClick={() => { setType(type === "snake" ? "linear" : "snake"); setDraft(null); setBatch(null); }}>
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
            onChange={(e) => { setRounds(Math.max(1, Math.min(30, Number(e.target.value) || 1))); setDraft(null); setBatch(null); }}
            style={{ width: 56 }}
          />
        </label>
        <span className="muted small">seed {seed}</span>
        <button onClick={reseed} title="New random CPU behaviour">🎲 reseed</button>
        {!draft && <button className="active" onClick={start}>▶ Start mock</button>}
        {draft && <button onClick={start}>↺ Restart</button>}
        <button onClick={runBatch} title={`Run ${BATCH_RUNS} seeded mocks with greedy picks for you`}>
          📊 Run {BATCH_RUNS} mocks
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
                  return (
                    <div key={r.key} className="pick-row">
                      <span className="rank num">#{r.consensus}</span>
                      {r.position ? <PosChip pos={r.position} /> : <span className="pos-chip pos-FLEX">?</span>}
                      <span className="who">
                        {r.displayName}
                        {suggestion?.key === r.key && <span className="muted small"> · engine's pick</span>}
                      </span>
                      <span className="meta num">
                        {v != null ? `${MODE_VALUE_LABEL[mode].toLowerCase()} ${v}` : ""}
                        {adp ? ` · mock ADP ${adp.avg}` : ""}
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
                          {MODE_VALUE_LABEL[mode].toLowerCase()} {Math.round(valueOf(p))}
                          {p.auto ? " · auto" : ""}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>Hauls by {MODE_VALUE_LABEL[mode].toLowerCase()} value</h3>
                <p className="muted small">
                  {finished
                    ? `Your ${myHaul.picks.length} picks rank #${myHaulRank} of ${hauls.length} by summed ${MODE_VALUE_LABEL[mode].toLowerCase()} value — a rough scorecard, not a grade.`
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

      {batch && (
        <div style={{ marginTop: 14 }}>
          <h3>Where the board falls — {batch.runs} mocks</h3>
          <p className="muted small">
            For each of your picks, who's most often still there. Greedy picks for you in every run, so this
            is "what falls to me", not "what I'd take".
          </p>
          <div className="table-wrap">
            <table className="fall-table">
              <thead>
                <tr>
                  <th>Your pick</th>
                  <th>Likely available</th>
                </tr>
              </thead>
              <tbody>
                {myPickNos
                  .filter((p) => batch.availability.has(p))
                  .slice(0, 8)
                  .map((pickNo) => {
                    const s = slotAt(setup, pickNo)!;
                    const tally = batch.availability.get(pickNo)!;
                    const rowsAt = board
                      .map((r) => ({ r, pct: (tally.get(r.key) ?? 0) / batch.runs }))
                      .filter((x) => x.pct >= 0.25)
                      .sort((a, b) => a.r.consensus - b.r.consensus)
                      .slice(0, 7);
                    return (
                      <tr key={pickNo}>
                        <td className="num">
                          <strong>#{pickNo}</strong> <span className="muted small">{pickLabel(s)}</span>
                        </td>
                        <td className="names small">
                          {rowsAt.length === 0 && <span className="muted">—</span>}
                          {rowsAt.map((x, i) => (
                            <span key={x.r.key}>
                              {i > 0 && <span className="muted"> · </span>}
                              {x.r.displayName}{" "}
                              <span className={`num ${x.pct >= 0.7 ? "muted" : "delta-down"}`}>{Math.round(x.pct * 100)}%</span>
                            </span>
                          ))}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
          <p className="muted small" style={{ marginTop: 8 }}>
            Mock ADP for the top of the board:{" "}
            {board
              .slice(0, 12)
              .map((r) => {
                const a = batch.adp.get(r.key);
                return a ? `${r.displayName} ${a.avg}` : null;
              })
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
      )}
    </div>
  );
}
