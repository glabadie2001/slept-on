import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppData } from "../AppContext";
import { PosChip, StatTile } from "../components";
import { idbGet, idbSet } from "../api/idb";
import { normalizeName } from "../api/marketValues";
import { sleeper } from "../api/sleeper";
import { liveGuideName, liveSourcesFor } from "../api/liveGuides";
import type { LiveGuideSource } from "../api/liveGuides";
import { aggregateGuides, parseGuide } from "../lib/guides";
import type { ConsensusRow, Guide } from "../lib/guides";
import {
  draftedPositionsFromPicks,
  marketDivergence,
  needMultipliers,
  pickNeedMultipliers,
  pickPosition,
  qbMarketContext,
  survivalOdds,
  upcomingPicks,
} from "../lib/draftIntel";
import type { QbContext } from "../lib/draftIntel";
import {
  DRAFT_MODES,
  DRAFT_MODE_BLURB,
  DRAFT_MODE_LABEL,
  MODE_VALUE_LABEL,
  boardPositions,
  defaultRounds,
  detectDraftMode,
  loadModeOverride,
  modeValue,
  saveModeOverride,
} from "../lib/draftMode";
import type { DraftMode } from "../lib/draftMode";
import type { MockAdp, MockPick } from "../lib/mockDraft";
import { isSuperflex } from "../lib/value";
import { log } from "../lib/log";
import {
  BUNDLED_AT,
  OVERALL_GUIDES_1QB,
  OVERALL_GUIDES_SF,
  ROOKIE_GUIDES_1QB,
  ROOKIE_GUIDES_SF,
} from "../data/bundledGuides";
import type { BundledGuide } from "../data/bundledGuides";
import { buildSampleGuides } from "../demo/sampleGuides";
import { MockDraft } from "./MockDraft";
import type { SleeperDraft, SleeperDraftPick } from "../types";

function guidesKey(leagueId: string): string {
  return `draft_guides:${leagueId}`;
}
const autoloadKey = (leagueId: string) => `draft_guides_autoloaded:${leagueId}`;

const SOURCE_ICON: Record<string, string> = { bundled: "⚡", live: "📡", sample: "🧪" };

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
  const [liveBusy, setLiveBusy] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);
  // guides state can change while async live fetches are in flight — merge via ref
  const guidesRef = useRef<Guide[]>([]);
  guidesRef.current = guides;

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
      guidesRef.current = next;
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
        source: "user",
      };
      persist([...guidesRef.current, guide]);
      setImportNote(`"${name}": ${entries.length} players${skipped ? ` (${skipped} lines skipped)` : ""}`);
      return true;
    },
    [persist],
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
  const [draftChecked, setDraftChecked] = useState(false);

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
      setDraftChecked(true);
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
      setDraftChecked(true);
    }
  }, [bundle, leagueId]);

  useEffect(() => {
    void loadDraft();
  }, [loadDraft]);

  // ---- draft mode (rookie / startup / redraft) ----
  const detectedMode = useMemo(
    () => detectDraftMode(bundle.league, bundle.rosters, draft),
    [bundle.league, bundle.rosters, draft],
  );
  const [modeOverride, setModeOverride] = useState<DraftMode | null>(() => loadModeOverride(leagueId));
  const mode: DraftMode = modeOverride ?? detectedMode;
  const setMode = (m: DraftMode | null) => {
    setModeOverride(m);
    saveModeOverride(leagueId, m);
    log.info("draft", `Draft mode → ${m ?? `auto (${detectedMode})`}`);
  };
  const positions = boardPositions(mode);
  const posFilters = ["ALL", ...positions];

  // ---- bundled + live guide sources ----
  const sf = isSuperflex(bundle.league);
  const rookieSet = sf ? ROOKIE_GUIDES_SF : ROOKIE_GUIDES_1QB;
  const overallSet = sf ? OVERALL_GUIDES_SF : OVERALL_GUIDES_1QB;
  const liveSources = liveSourcesFor(mode);

  const loadBundled = useCallback(
    (set: BundledGuide[], quiet = false) => {
      const have = new Set(guidesRef.current.map((g) => g.name));
      const fresh = set.filter((b) => !have.has(b.name));
      if (fresh.length === 0) {
        if (!quiet) setImportNote("Those scraped guides are already loaded.");
        return 0;
      }
      persist([
        ...guidesRef.current,
        ...fresh.map((b, i) => ({
          id: `b${Date.now()}-${i}`,
          name: b.name,
          addedAt: Date.now() + i,
          entries: b.entries,
          source: "bundled" as const,
        })),
      ]);
      if (!quiet) setImportNote(`Loaded ${fresh.length} scraped guide${fresh.length === 1 ? "" : "s"} (${BUNDLED_AT}).`);
      return fresh.length;
    },
    [persist],
  );

  const loadLive = useCallback(
    async (source: LiveGuideSource, quiet = false): Promise<string | null> => {
      const name = liveGuideName(source, bundle.league, mode);
      setLiveBusy((s) => new Set(s).add(source.id));
      try {
        const entries = await source.fetch(bundle.league, bundle.players, mode);
        const guide: Guide = {
          id: `live-${source.id}-${Date.now()}`,
          name,
          addedAt: Date.now(),
          entries,
          source: "live",
        };
        // refresh replaces the previous pull of the same feed
        persist([...guidesRef.current.filter((g) => g.name !== name), guide]);
        log.info("draft", `Live guide loaded: ${name} (${entries.length})`);
        if (!quiet) setImportNote(`"${name}": ${entries.length} players (fetched just now).`);
        return null;
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        // "Load failed" / "Failed to fetch" = the browser never got a response (network or CORS)
        const msg = /load failed|failed to fetch|networkerror/i.test(raw) ? `${raw} (network or CORS block)` : raw;
        log.warn("draft", `Live guide failed: ${name} — ${msg}`);
        if (!quiet) setImportNote(`Couldn't fetch ${source.name}: ${msg}. You can still paste or upload that board.`);
        return `${source.name}: ${msg}`;
      } finally {
        setLiveBusy((s) => {
          const n = new Set(s);
          n.delete(source.id);
          return n;
        });
      }
    },
    [bundle.league, bundle.players, mode, persist],
  );

  // First visit for a league: load the default set for its draft mode so the
  // board isn't empty — bundled boards instantly, live feeds as they arrive.
  useEffect(() => {
    if (!loaded || !draftChecked || guides.length > 0) return;
    try {
      if (localStorage.getItem(autoloadKey(leagueId))) return;
      localStorage.setItem(autoloadKey(leagueId), String(Date.now()));
    } catch {
      return;
    }
    if (bundle.demo) {
      persist(buildSampleGuides(bundle.players));
      setImportNote("Loaded the demo's 3 sample guides by default.");
      return;
    }
    const n = mode === "rookie" ? loadBundled(rookieSet, true) : mode === "startup" ? loadBundled(overallSet, true) : 0;
    const live = liveSourcesFor(mode);
    setImportNote(
      `${n ? `Loaded ${n} bundled ${mode === "rookie" ? "rookie" : "dynasty"} guides (${BUNDLED_AT})` : "No bundled boards for this format"}${
        live.length ? ` · fetching ${live.map((s) => s.name).join(" + ")}…` : ""
      }`,
    );
    void Promise.all(live.map((s) => loadLive(s, true))).then((results) => {
      const failures = results.filter((r): r is string => r != null);
      const got = live.length - failures.length;
      if (live.length) {
        setImportNote(
          `Default guides loaded: ${n} bundled · ${got}/${live.length} live feed${live.length === 1 ? "" : "s"}.${
            failures.length ? ` Couldn't fetch ${failures.join("; ")} — paste or upload that board instead.` : ""
          }`,
        );
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, draftChecked, guides.length, leagueId, mode, bundle.demo]);

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
  const [mockAdp, setMockAdp] = useState<Map<string, MockAdp> | null>(null);
  const [hideDrafted, setHideDrafted] = useState(true);
  const [hideRostered, setHideRostered] = useState(false);
  const [sortBy, setSortBy] = useState<"consensus" | "divisive" | "steals" | "value" | "adp">("consensus");
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!positions.includes(posFilter) && posFilter !== "ALL") setPosFilter("ALL");
  }, [positions, posFilter]);

  const isDrafted = useCallback(
    (row: ConsensusRow) =>
      (row.sleeperId != null && draftedIds.has(row.sleeperId)) || draftedNames.has(row.key),
    [draftedIds, draftedNames],
  );
  const rowValue = useCallback(
    (row: ConsensusRow): number | null => modeValue(mode, row.sleeperId ? values[row.sleeperId] : null),
    [mode, values],
  );

  // ---- draft intelligence ----
  const divergence = useMemo(() => marketDivergence(board, values), [board, values]);
  const qbCtx = useMemo<QbContext>(
    () =>
      mode === "rookie"
        ? qbMarketContext(bundle.league, bundle.rosters, bundle.players, values)
        : { dead: false, setTeams: 0, totalTeams: bundle.rosters.length, reason: "Every team is drafting a QB room from scratch." },
    [mode, bundle, values],
  );
  // Rookie drafts: appetite from what each roster already has. Startup/redraft:
  // rosters are empty, appetite is what each team has drafted so far.
  const rookieNeeds = useMemo(
    () =>
      mode === "rookie"
        ? needMultipliers(bundle.league, bundle.rosters, bundle.players, values, qbCtx)
        : new Map<number, Record<string, number>>(),
    [mode, bundle, values, qbCtx],
  );
  const needs = useMemo(() => {
    if (mode === "rookie") return rookieNeeds;
    const r = defaultRounds(mode, bundle.league, draft);
    return pickNeedMultipliers(
      bundle.league,
      r,
      onClock?.round ?? 1,
      draftedPositionsFromPicks(picks, bundle.players),
      bundle.rosters.map((x) => x.roster_id),
    );
  }, [mode, rookieNeeds, bundle, draft, onClock?.round, picks]);

  // In a rookie draft, rostered players aren't draftable. In a startup/redraft
  // the rosters *are* the draft results, so only real picks come off the board.
  const availableRows = useMemo(
    () =>
      board.filter(
        (r) => !isDrafted(r) && !(mode === "rookie" && r.sleeperId && rosteredIds.has(r.sleeperId)),
      ),
    [board, isDrafted, rosteredIds, mode],
  );
  const upcoming = useMemo(
    () =>
      draft && myTeam ? upcomingPicks(draft, bundle.tradedPicks, picks.length, myTeam.rosterId) : null,
    [draft, bundle.tradedPicks, picks.length, myTeam],
  );
  const survival = useMemo(
    () =>
      upcoming && upcoming.myNextPick != null
        ? survivalOdds(availableRows, upcoming.interveningRosters, needs)
        : null,
    [availableRows, upcoming, needs],
  );
  const liveDrafting = draft?.status === "drafting";
  const myTurn = liveDrafting && !!onClockTeam?.isMine;
  const marketSteal = useMemo(() => {
    let best: { row: ConsensusRow; div: number } | null = null;
    for (const row of availableRows) {
      const d = divergence.get(row.key);
      if (!d || d.divergence < 5 || d.marketRank > 30) continue;
      if (!best || d.divergence > best.div) best = { row, div: d.divergence };
    }
    return best;
  }, [availableRows, divergence]);
  const wontLast = useMemo(
    () =>
      survival
        ? availableRows
            .slice(0, 15)
            .filter((r) => (survival.get(r.key) ?? 1) < 0.45)
            .slice(0, 3)
        : [],
    [availableRows, survival],
  );

  // Real picks → mock-draft picks so the mock can continue a live draft.
  const realMockPicks = useMemo<MockPick[]>(
    () =>
      picks.map((p) => {
        const pl = bundle.players[p.player_id];
        const name = pl?.full_name ?? `${p.metadata?.first_name ?? ""} ${p.metadata?.last_name ?? ""}`.trim();
        const rosterId = p.roster_id ?? draft?.slot_to_roster_id?.[String(p.draft_slot)] ?? -1;
        return {
          pickNo: p.pick_no,
          round: p.round,
          slot: p.draft_slot,
          rosterId,
          key: normalizeName(name) || `sleeper:${p.player_id}`,
          displayName: name || p.player_id,
          position: pl?.position ?? p.metadata?.position ?? null,
          sleeperId: p.player_id,
          mine: rosterId === myTeam?.rosterId,
          auto: false,
          real: true,
        };
      }),
    [picks, bundle.players, draft, myTeam?.rosterId],
  );

  const filtered = useMemo(() => {
    let rows = board;
    if (posFilter !== "ALL") rows = rows.filter((r) => r.position === posFilter);
    if (hideDrafted && picks.length > 0) rows = rows.filter((r) => !isDrafted(r));
    if (hideRostered && mode === "rookie") rows = rows.filter((r) => !(r.sleeperId && rosteredIds.has(r.sleeperId)));
    if (search.trim()) {
      const q = normalizeName(search);
      rows = rows.filter((r) => r.key.includes(q));
    }
    if (sortBy === "divisive") {
      rows = [...rows].sort((a, b) => b.sd - a.sd || a.avg - b.avg);
    } else if (sortBy === "steals") {
      const div = (r: ConsensusRow) => divergence.get(r.key)?.divergence ?? -1e9;
      rows = [...rows].sort((a, b) => div(b) - div(a) || a.avg - b.avg);
    } else if (sortBy === "value") {
      rows = [...rows].sort((a, b) => (rowValue(b) ?? -1) - (rowValue(a) ?? -1) || a.avg - b.avg);
    } else if (sortBy === "adp" && mockAdp) {
      const adp = (r: ConsensusRow) => mockAdp.get(r.key)?.avg ?? 1e9;
      rows = [...rows].sort((a, b) => adp(a) - adp(b) || a.avg - b.avg);
    }
    return rows;
  }, [board, posFilter, hideDrafted, hideRostered, mode, sortBy, search, picks.length, isDrafted, rosteredIds, divergence, rowValue, mockAdp]);

  const visible = showAll ? filtered : filtered.slice(0, 60);

  const spicyTakes = useMemo(
    () =>
      board
        .filter((r) => r.count >= 2 && r.worst - r.best >= 6)
        .sort((a, b) => b.worst - b.best - (a.worst - a.best))
        .slice(0, 5),
    [board],
  );

  const cycleSort = () => {
    const order: (typeof sortBy)[] = mockAdp
      ? ["consensus", "divisive", "steals", "value", "adp"]
      : ["consensus", "divisive", "steals", "value"];
    setSortBy(order[(order.indexOf(sortBy) + 1) % order.length]);
  };
  const sortLabel =
    sortBy === "divisive" ? "most divisive" : sortBy === "steals" ? "market steals" : sortBy === "value" ? MODE_VALUE_LABEL[mode].toLowerCase() : sortBy === "adp" ? "mock ADP" : "consensus";

  const valueLabel = MODE_VALUE_LABEL[mode];

  return (
    <div>
      <div className="stat-row">
        <StatTile label="Guides loaded" value={guides.length} sub={`${board.length} unique players ranked`} />
        <StatTile
          label="Draft status"
          value={draft ? draft.status.replace("_", " ") : draftLoading ? "…" : "none found"}
          sub={draft ? `${draft.season} · ${draft.type} · ${rounds} rounds · ${DRAFT_MODE_LABEL[mode].toLowerCase()}` : DRAFT_MODE_LABEL[mode].toLowerCase()}
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

      <div className="mode-row">
        <span className="label">Draft type</span>
        <div className="pill-row" style={{ marginBottom: 0 }}>
          {DRAFT_MODES.map((m) => (
            <button
              key={m}
              className={mode === m ? "active" : ""}
              onClick={() => setMode(m === detectedMode ? null : m)}
              title={DRAFT_MODE_BLURB[m]}
            >
              {DRAFT_MODE_LABEL[m]}
              {m === detectedMode && <span className="small"> · auto</span>}
            </button>
          ))}
        </div>
        <span className="muted small">{DRAFT_MODE_BLURB[mode]}</span>
      </div>

      {liveDrafting && upcoming && (myTurn || wontLast.length > 0 || marketSteal) && (
        <div className="card section" style={myTurn ? { borderColor: "var(--delta-up)" } : undefined}>
          <h2>
            {myTurn
              ? `🚨 You're on the clock — pick ${nextPickNo}${onClock ? ` (R${onClock.round}.${String(onClock.slot).padStart(2, "0")})` : ""}`
              : upcoming.myNextPick != null
                ? `⏳ Your next pick is #${upcoming.myNextPick} — ${upcoming.interveningRosters.length} pick${upcoming.interveningRosters.length === 1 ? "" : "s"} before you`
                : "Draft intel"}
          </h2>
          <ul className="advice-list">
            {availableRows[0] && (
              <li>
                <span className="icon">🥇</span>
                <span>
                  Top of your board: <strong>{availableRows[0].displayName}</strong>{" "}
                  {availableRows[0].position && <PosChip pos={availableRows[0].position} />}{" "}
                  <span className="muted small">consensus #{availableRows[0].consensus}</span>
                </span>
              </li>
            )}
            {marketSteal && marketSteal.row.key !== availableRows[0]?.key && (
              <li>
                <span className="icon">💰</span>
                <span>
                  Market disagrees with your guides on <strong>{marketSteal.row.displayName}</strong>{" "}
                  {marketSteal.row.position && <PosChip pos={marketSteal.row.position} />}{" "}
                  <span className="muted small">
                    market #{divergence.get(marketSteal.row.key)?.marketRank} vs consensus #
                    {marketSteal.row.consensus} — when they split, the market has the better recent record
                  </span>
                </span>
              </li>
            )}
            {wontLast.map((r) => (
              <li key={r.key}>
                <span className="icon">⏱️</span>
                <span>
                  <strong>{r.displayName}</strong> {r.position && <PosChip pos={r.position} />}{" "}
                  <span className="muted small">
                    only {Math.round((survival?.get(r.key) ?? 1) * 100)}% likely to last to your next
                    pick — take now or lose him
                  </span>
                </span>
              </li>
            ))}
            {qbCtx.dead && availableRows.some((r) => r.position === "QB" && r.consensus <= 10) && (
              <li>
                <span className="icon">⛔</span>
                <span>
                  <span className="muted small">{qbCtx.reason} Skip QBs regardless of board rank.</span>
                </span>
              </li>
            )}
          </ul>
        </div>
      )}

      <div className="card section">
        <h2>Draft guides</h2>
        <p className="muted small">
          Feed it every guide you can find — CSV, spreadsheet paste, or a ranked list copied out of
          a PDF ("12. Player Name", tiers welcome). Each source becomes a column in the consensus.
          {mode === "redraft"
            ? " Redraft boards come from live feeds (FantasyCalc redraft values, Sleeper's own ADP) matched to this league's scoring and QB format — the bundled boards are dynasty rankings and stay out of the way here."
            : ` Boards scraped ${BUNDLED_AT} (FantasyPros ECR, KeepTradeCut, CBS, Matthew Berry) are bundled and load the ${sf ? "superflex" : "1QB"} versions automatically; live FantasyCalc rankings and Sleeper ADP refresh on demand.`}
        </p>
        {guides.length > 0 && (
          <div className="guide-list">
            {guides.map((g) => (
              <span key={g.id} className={`guide-chip${g.source ? ` ${g.source}` : ""}`} title={g.source ? `${g.source} guide` : "your upload"}>
                {g.source && SOURCE_ICON[g.source] && <span>{SOURCE_ICON[g.source]}</span>}
                <strong>{g.name}</strong>
                <span className="muted small"> · {g.entries.length}</span>
                <button onClick={() => removeGuide(g.id)} title="Remove guide">✕</button>
              </span>
            ))}
          </div>
        )}
        <div className="pill-row" style={{ marginBottom: 0 }}>
          {mode !== "redraft" && (
            <>
              <button
                onClick={() => loadBundled(rookieSet)}
                title={`Scraped ${BUNDLED_AT}: ${rookieSet.map((g) => g.name).join(", ")}`}
              >
                ⚡ Rookie guides ({rookieSet.length})
              </button>
              <button
                onClick={() => loadBundled(overallSet)}
                title={`Scraped ${BUNDLED_AT}: ${overallSet.map((g) => g.name).join(", ")}`}
              >
                ⚡ Overall dynasty guides ({overallSet.length})
              </button>
            </>
          )}
          {!bundle.demo &&
            liveSources.map((s) => (
              <button
                key={s.id}
                onClick={() => void loadLive(s)}
                disabled={liveBusy.has(s.id)}
                title={`Fetch ${liveGuideName(s, bundle.league, mode)} now`}
              >
                {liveBusy.has(s.id) ? "⏳" : "📡"} {s.name}
                {guides.some((g) => g.name === liveGuideName(s, bundle.league, mode)) ? " (refresh)" : ""}
              </button>
            ))}
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
              {posFilters.map((p) => (
                <button key={p} className={posFilter === p ? "active" : ""} onClick={() => setPosFilter(p)}>
                  {p}
                </button>
              ))}
              <button className={sortBy !== "consensus" ? "active" : ""} onClick={cycleSort}>
                sort: {sortLabel}
              </button>
              {picks.length > 0 && (
                <button className={hideDrafted ? "active" : ""} onClick={() => setHideDrafted((v) => !v)}>
                  hide drafted
                </button>
              )}
              {mode === "rookie" && (
                <button className={hideRostered ? "active" : ""} onClick={() => setHideRostered((v) => !v)}
                  title="Hide players already on a roster in your league">
                  available only
                </button>
              )}
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
                  <th className="right" title={mode === "redraft" ? "Win-now production score (age ignored)" : "Dynasty value (production × age + upside, market-blended)"}>
                    {valueLabel}
                  </th>
                  <th className="right">Market</th>
                  <th className="right" title="Market rank vs consensus rank — positive means the market is higher on him than your guides">
                    Δ mkt
                  </th>
                  {survival && (
                    <th className="right" title="Chance he's still available at your next pick">
                      Lasts
                    </th>
                  )}
                  {mockAdp && (
                    <th className="right" title="Average overall pick across the last batch of mock drafts, with the pick range. Δ = mock ADP − consensus rank: positive means he falls past his rank, negative means the CPU reaches for him.">
                      Mock ADP
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const v = r.sleeperId ? values[r.sleeperId] : null;
                  const mv = rowValue(r);
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
                              {qbCtx.dead && r.position === "QB" && (
                                <span className="muted small" title={qbCtx.reason}> · no QB market</span>
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
                      <td className="right num">{mv != null ? mv : "—"}</td>
                      <td className="right num muted">{v?.market != null ? v.market.toLocaleString() : "—"}</td>
                      {(() => {
                        const d = divergence.get(r.key);
                        return (
                          <td className={`right num${d && d.divergence >= 5 ? " delta-up" : d && d.divergence <= -5 ? " delta-down" : " muted"}`}>
                            {d ? (d.divergence > 0 ? `+${d.divergence}` : d.divergence) : "—"}
                          </td>
                        );
                      })()}
                      {survival && (
                        <td className={`right num${!drafted && (survival.get(r.key) ?? 1) < 0.45 ? " delta-down" : " muted"}`}>
                          {drafted ? "—" : survival.has(r.key) ? `${Math.round(survival.get(r.key)! * 100)}%` : "—"}
                        </td>
                      )}
                      {mockAdp && (() => {
                        const a = mockAdp.get(r.key);
                        if (!a) return <td className="right num muted">—</td>;
                        const delta = Math.round(a.avg - r.consensus);
                        return (
                          <td className="right num" title={`range ${a.min}–${a.max} across ${a.n} timelines`}>
                            {a.avg}{" "}
                            <span className={`small${delta >= 4 ? " delta-up" : delta <= -4 ? " delta-down" : " muted"}`}>
                              {delta > 0 ? `+${delta}` : delta}
                            </span>
                          </td>
                        );
                      })()}
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

      <MockDraft
        mode={mode}
        board={availableRows}
        realPicks={realMockPicks}
        sleeperDraft={draft}
        needBase={rookieNeeds}
        positions={positions}
        onAdp={setMockAdp}
      />

      <div className="card">
        <h2>Draft room</h2>
        {draftError && <div className="error-box">{draftError}</div>}
        {!draft && !draftLoading && !draftError && (
          <p className="muted">
            No draft found on Sleeper for this league yet — it will appear here once your league's{" "}
            {mode === "rookie" ? "rookie draft" : "draft"} is created. The mock draft above works without it.
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
