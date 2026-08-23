import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppData } from "../AppContext";
import { PosChip, StatTile } from "../components";
import { idbGet, idbSet } from "../api/idb";
import { normalizeName } from "../api/marketValues";
import { sleeper } from "../api/sleeper";
import { aggregateGuides, parseGuide } from "../lib/guides";
import type { ConsensusRow, Guide } from "../lib/guides";
import { buildSampleGuides } from "../demo/sampleGuides";
import type { SleeperDraft, SleeperDraftPick } from "../types";

const POS_FILTERS = ["ALL", "QB", "RB", "WR", "TE"];

function guidesKey(leagueId: string): string {
  return `draft_guides:${leagueId}`;
}

/** overall pick number → round + slot (snake or linear) */
export function pickPosition(
  pickNo: number,
  teams: number,
  type: SleeperDraft["type"],
): { round: number; slot: number } {
  const round = Math.ceil(pickNo / teams);
  const idx = (pickNo - 1) % teams;
  const slot = type === "snake" && round % 2 === 0 ? teams - idx : idx + 1;
  return { round, slot };
}

export function Draft() {
  const { bundle, teams, myTeam, values } = useAppData();
  const leagueId = bundle.league.league_id;
  const byRoster = new Map(teams.map((t) => [t.rosterId, t]));

  // ---- guides ----
  const [guides, setGuides] = useState<Guide[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [guideName, setGuideName] = useState("");
  const [guideText, setGuideText] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    idbGet<Guide[]>(guidesKey(leagueId)).then((g) => {
      if (!cancelled) {
        if (g) setGuides(g);
        setLoaded(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [leagueId]);

  const persist = useCallback(
    (next: Guide[]) => {
      setGuides(next);
      void idbSet(guidesKey(leagueId), next);
    },
    [leagueId],
  );

  const addGuide = useCallback(
    (name: string, text: string) => {
      const { entries, skipped } = parseGuide(text);
      if (entries.length === 0) {
        setImportNote(`"${name}": no parsable lines (${skipped} skipped) — expected ranked names, one per line`);
        return false;
      }
      const guide: Guide = {
        id: `g${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        name,
        addedAt: Date.now(),
        entries,
      };
      persist([...guides, guide]);
      setImportNote(`"${name}": ${entries.length} players${skipped ? ` (${skipped} lines skipped)` : ""}`);
      return true;
    },
    [guides, persist],
  );

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      const text = await file.text();
      addGuide(file.name.replace(/\.(csv|tsv|txt)$/i, ""), text);
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const removeGuide = (id: string) => persist(guides.filter((g) => g.id !== id));

  // ---- Sleeper draft room ----
  const [draft, setDraft] = useState<SleeperDraft | null>(null);
  const [picks, setPicks] = useState<SleeperDraftPick[]>([]);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);

  const loadDraft = useCallback(async () => {
    if (bundle.demo) {
      // Synthetic upcoming rookie draft: order = reverse standings.
      const order = [...bundle.rosters]
        .sort(
          (a, b) => a.settings.wins - b.settings.wins || a.settings.fpts - b.settings.fpts,
        )
        .map((r) => r.roster_id);
      setDraft({
        draft_id: "demo-draft",
        status: "pre_draft",
        type: "linear",
        season: String(Number(bundle.league.season) + 1),
        start_time: null,
        settings: { rounds: 4, teams: order.length },
        draft_order: null,
        slot_to_roster_id: Object.fromEntries(order.map((rid, i) => [String(i + 1), rid])),
      });
      setPicks([]);
      return;
    }
    setDraftLoading(true);
    setDraftError(null);
    try {
      const drafts = await sleeper.getLeagueDrafts(leagueId);
      const latest = drafts?.[0] ?? null;
      setDraft(latest);
      if (latest) {
        const p = await sleeper.getDraftPicks(latest.draft_id);
        setPicks(p ?? []);
      }
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setDraftLoading(false);
    }
  }, [bundle, leagueId]);

  useEffect(() => {
    void loadDraft();
  }, [loadDraft]);

  const draftedIds = useMemo(() => new Set(picks.map((p) => p.player_id)), [picks]);
  const draftedNames = useMemo(
    () =>
      new Set(
        picks
          .map((p) =>
            p.metadata?.first_name ? normalizeName(`${p.metadata.first_name} ${p.metadata.last_name ?? ""}`) : null,
          )
          .filter((n): n is string => !!n),
      ),
    [picks],
  );

  const slotOf = (rosterId: number | undefined): number | null => {
    if (rosterId == null || !draft?.slot_to_roster_id) return null;
    for (const [slot, rid] of Object.entries(draft.slot_to_roster_id)) {
      if (rid === rosterId) return Number(slot);
    }
    return null;
  };
  const mySlot = slotOf(myTeam?.rosterId);
  const teamsInDraft = draft?.settings.teams ?? bundle.rosters.length;
  const rounds = draft?.settings.rounds ?? 0;
  const totalPicks = teamsInDraft * rounds;
  const nextPickNo = picks.length + 1;
  const onClock =
    draft && picks.length < totalPicks ? pickPosition(nextPickNo, teamsInDraft, draft.type) : null;
  const onClockTeam =
    onClock && draft?.slot_to_roster_id ? byRoster.get(draft.slot_to_roster_id[String(onClock.slot)]) : null;

  // ---- consensus board ----
  const board = useMemo(() => aggregateGuides(guides, bundle.players), [guides, bundle.players]);

  const rosteredIds = useMemo(() => {
    const s = new Set<string>();
    for (const r of bundle.rosters) for (const id of r.players ?? []) s.add(id);
    return s;
  }, [bundle.rosters]);

  const [posFilter, setPosFilter] = useState("ALL");
  const [hideDrafted, setHideDrafted] = useState(true);
  const [hideRostered, setHideRostered] = useState(false);
  const [sortBy, setSortBy] = useState<"consensus" | "divisive">("consensus");
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);

  const isDrafted = useCallback(
    (row: ConsensusRow) =>
      (row.sleeperId != null && draftedIds.has(row.sleeperId)) || draftedNames.has(row.key),
    [draftedIds, draftedNames],
  );

  const filtered = useMemo(() => {
    let rows = board;
    if (posFilter !== "ALL") rows = rows.filter((r) => r.position === posFilter);
    if (hideDrafted && picks.length > 0) rows = rows.filter((r) => !isDrafted(r));
    if (hideRostered) rows = rows.filter((r) => !(r.sleeperId && rosteredIds.has(r.sleeperId)));
    if (search.trim()) {
      const q = normalizeName(search);
      rows = rows.filter((r) => r.key.includes(q));
    }
    if (sortBy === "divisive") {
      rows = [...rows].sort((a, b) => b.sd - a.sd || a.avg - b.avg);
    }
    return rows;
  }, [board, posFilter, hideDrafted, hideRostered, sortBy, search, picks.length, isDrafted, rosteredIds]);

  const visible = showAll ? filtered : filtered.slice(0, 60);

  const spicyTakes = useMemo(
    () =>
      board
        .filter((r) => r.count >= 2 && r.worst - r.best >= 6)
        .sort((a, b) => b.worst - b.best - (a.worst - a.best))
        .slice(0, 5),
    [board],
  );

  return (
    <div>
      <div className="stat-row">
        <StatTile label="Guides loaded" value={guides.length} sub={`${board.length} unique players ranked`} />
        <StatTile
          label="Draft status"
          value={draft ? draft.status.replace("_", " ") : draftLoading ? "…" : "none found"}
          sub={draft ? `${draft.season} · ${draft.type} · ${rounds} rounds` : "no draft on Sleeper yet"}
        />
        <StatTile
          label="Your draft slot"
          value={mySlot != null ? `#${mySlot}` : "—"}
          sub={bundle.demo ? "reverse standings (demo)" : draft?.draft_order ? "" : "order not set yet"}
        />
        <StatTile
          label={draft?.status === "drafting" ? "On the clock" : "Picks made"}
          value={
            draft?.status === "drafting" && onClockTeam
              ? onClockTeam.teamName
              : `${picks.length}${totalPicks ? `/${totalPicks}` : ""}`
          }
          sub={onClock ? `pick ${nextPickNo} (R${onClock.round}.${String(onClock.slot).padStart(2, "0")})` : ""}
        />
      </div>

      <div className="card section">
        <h2>Draft guides</h2>
        <p className="muted small">
          Feed it every guide you can find — CSV, spreadsheet paste, or a ranked list copied out of
          a PDF ("12. Player Name", tiers welcome). Each source becomes a column in the consensus.
        </p>
        {guides.length > 0 && (
          <div className="guide-list">
            {guides.map((g) => (
              <span key={g.id} className="guide-chip">
                <strong>{g.name}</strong>
                <span className="muted small"> · {g.entries.length}</span>
                <button onClick={() => removeGuide(g.id)} title="Remove guide">✕</button>
              </span>
            ))}
          </div>
        )}
        <div className="pill-row" style={{ marginBottom: 0 }}>
          <button onClick={() => fileRef.current?.click()}>📄 Upload files</button>
          <button onClick={() => setShowPaste((v) => !v)}>Paste a guide</button>
          {bundle.demo && guides.length === 0 && loaded && (
            <button className="active" onClick={() => persist(buildSampleGuides(bundle.players))}>
              Load 3 sample guides
            </button>
          )}
          {guides.length > 0 && <button onClick={() => persist([])}>Clear all</button>}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.tsv,.txt"
          multiple
          style={{ display: "none" }}
          onChange={(e) => void onFiles(e.target.files)}
        />
        {showPaste && (
          <div style={{ marginTop: 10 }}>
            <input
              type="text"
              placeholder="Guide name (e.g. 'FantasyPros rookies')"
              value={guideName}
              onChange={(e) => setGuideName(e.target.value)}
              style={{ marginBottom: 6, width: "100%" }}
            />
            <textarea
              className="import-box"
              rows={7}
              placeholder={"1. Ashton Jeanty, RB\n2. Travis Hunter, WR\nTier 2\n3. Omarion Hampton RB\n..."}
              value={guideText}
              onChange={(e) => setGuideText(e.target.value)}
            />
            <div className="pill-row" style={{ marginTop: 6, marginBottom: 0 }}>
              <button
                className="active"
                disabled={!guideText.trim()}
                onClick={() => {
                  if (addGuide(guideName.trim() || `Pasted guide ${guides.length + 1}`, guideText)) {
                    setGuideText("");
                    setGuideName("");
                    setShowPaste(false);
                  }
                }}
              >
                Add guide
              </button>
              <button onClick={() => setShowPaste(false)}>Cancel</button>
            </div>
          </div>
        )}
        {importNote && <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>{importNote}</p>}
      </div>

      {spicyTakes.length > 0 && (
        <div className="card section">
          <h2>Where your guides disagree</h2>
          <p className="muted small">
            Biggest rank gaps between sources — one analyst's sleeper is another's fade. These are
            the picks where your own judgement earns its keep.
          </p>
          <ul className="advice-list">
            {spicyTakes.map((r) => (
              <li key={r.key}>
                <span className="icon">🔥</span>
                <span>
                  <strong>{r.displayName}</strong>{" "}
                  {r.position && <PosChip pos={r.position} />}{" "}
                  <span className="muted small">
                    best #{r.best} · worst #{r.worst} · consensus #{r.consensus}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {board.length > 0 && (
        <div className="card section">
          <h2>Consensus board</h2>
          <div className="board-controls">
            <div className="pill-row" style={{ marginBottom: 0 }}>
              {POS_FILTERS.map((p) => (
                <button key={p} className={posFilter === p ? "active" : ""} onClick={() => setPosFilter(p)}>
                  {p}
                </button>
              ))}
              <button className={sortBy === "divisive" ? "active" : ""}
                onClick={() => setSortBy(sortBy === "divisive" ? "consensus" : "divisive")}>
                sort: {sortBy === "divisive" ? "most divisive" : "consensus"}
              </button>
              {picks.length > 0 && (
                <button className={hideDrafted ? "active" : ""} onClick={() => setHideDrafted((v) => !v)}>
                  hide drafted
                </button>
              )}
              <button className={hideRostered ? "active" : ""} onClick={() => setHideRostered((v) => !v)}
                title="Hide players already on a roster in your league">
                available only
              </button>
            </div>
            <input
              type="text"
              placeholder="Search player…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ maxWidth: 200 }}
            />
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Player</th>
                  <th className="right">Avg rank</th>
                  <th className="right">Range</th>
                  <th className="right">σ</th>
                  <th className="right">In guides</th>
                  <th className="right">Tier</th>
                  <th className="right">Value</th>
                  <th className="right">Market</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const v = r.sleeperId ? values[r.sleeperId] : null;
                  const drafted = isDrafted(r);
                  const p = r.sleeperId ? bundle.players[r.sleeperId] : null;
                  return (
                    <tr key={r.key} className={drafted ? "drafted-row" : ""}>
                      <td className="num">{r.consensus}</td>
                      <td>
                        <div className="player-cell">
                          {r.position ? <PosChip pos={r.position} /> : <span className="pos-chip pos-FLEX">?</span>}
                          <div style={{ minWidth: 0 }}>
                            <div className="player-name">
                              {r.displayName}
                              {drafted && <span className="muted small"> · drafted</span>}
                              {!r.sleeperId && (
                                <span className="muted small" title="Not matched to a Sleeper player"> · unmatched</span>
                              )}
                            </div>
                            {p && (
                              <div className="player-meta">
                                {p.team ?? "FA"}
                                {p.age ? ` · ${p.age}y` : ""}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="right num"><strong>{r.avg}</strong></td>
                      <td className="right num muted">{r.best === r.worst ? r.best : `${r.best}–${r.worst}`}</td>
                      <td className={`right num${r.sd >= 6 ? " delta-down" : ""}`}>{r.sd || "—"}</td>
                      <td className="right num muted">{r.count}/{guides.length}</td>
                      <td className="right num muted">{r.tier ?? "—"}</td>
                      <td className="right num">{v ? v.value : "—"}</td>
                      <td className="right num muted">{v?.market != null ? v.market.toLocaleString() : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {filtered.length > 60 && !showAll && (
            <div className="pill-row" style={{ marginTop: 10, marginBottom: 0 }}>
              <button onClick={() => setShowAll(true)}>Show all {filtered.length}</button>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h2>Draft room</h2>
        {draftError && <div className="error-box">{draftError}</div>}
        {!draft && !draftLoading && !draftError && (
          <p className="muted">
            No draft found on Sleeper for this league yet — it will appear here once your league's
            rookie draft is created.
          </p>
        )}
        {draft && (
          <>
            <p className="muted small">
              {draft.season} {draft.type} draft · {rounds} rounds · {teamsInDraft} teams
              {draft.start_time
                ? ` · starts ${new Date(draft.start_time).toLocaleString()}`
                : ""}
              {bundle.demo && " · synthesized for the demo (order = reverse standings)"}
            </p>
            {draft.slot_to_roster_id && (
              <div className="draft-order">
                {Object.entries(draft.slot_to_roster_id)
                  .sort((a, b) => Number(a[0]) - Number(b[0]))
                  .map(([slot, rid]) => {
                    const t = byRoster.get(rid);
                    return (
                      <span key={slot} className={`order-chip${t?.isMine ? " mine" : ""}`}>
                        {slot}. {t?.teamName ?? `Roster ${rid}`}
                      </span>
                    );
                  })}
              </div>
            )}
            {picks.length > 0 && (
              <>
                <h3 style={{ marginTop: 12 }}>Latest picks</h3>
                <ul className="advice-list">
                  {picks.slice(-8).reverse().map((p) => {
                    const t = p.roster_id != null ? byRoster.get(p.roster_id) : null;
                    const name = bundle.players[p.player_id]?.full_name
                      ?? `${p.metadata?.first_name ?? "?"} ${p.metadata?.last_name ?? ""}`;
                    return (
                      <li key={p.pick_no}>
                        <span className="icon num muted">R{p.round}.{String(p.draft_slot).padStart(2, "0")}</span>
                        <span>
                          <strong>{name}</strong>{" "}
                          {p.metadata?.position && <PosChip pos={p.metadata.position} />}{" "}
                          <span className="muted small">→ {t?.teamName ?? "?"}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            {!bundle.demo && (
              <div className="pill-row" style={{ marginTop: 10, marginBottom: 0 }}>
                <button onClick={() => void loadDraft()} disabled={draftLoading}>
                  {draftLoading ? "Refreshing…" : "↻ Sync picks"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
