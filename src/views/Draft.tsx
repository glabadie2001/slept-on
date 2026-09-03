import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppData } from "../AppContext";
import { PosChip, StatTile } from "../components";
import { idbGet, idbSet } from "../api/idb";
import { normalizeName } from "../api/marketValues";
import { sleeper } from "../api/sleeper";
import { liveGuideName, liveSourcesFor } from "../api/liveGuides";
import type { LiveGuideSource } from "../api/liveGuides";
import { fetchDraftHistory, loadCachedHistory } from "../api/draftHistory";
import type { DraftHistoryBundle } from "../api/draftHistory";
import {
  AVAILABILITY_KINDS,
  GUIDE_KIND_LABEL,
  VALUE_KINDS,
  buildBoard,
  guideWarnings,
  guideWeight,
  inferKind,
  parseAdpCsv,
  parseGuide,
} from "../lib/guides";
import type { ConsensusRow, Guide, GuideKind } from "../lib/guides";
import { parseProjectionCsv, projectionCsvEntries } from "../lib/projections";
import { deriveTendencies, describePrior, priorsByRoster } from "../lib/draftHistory";
import { BUNDLED_ADP } from "../data/bundledAdp";
import {
  draftedPositionsFromPicks,
  marketDivergence,
  needMultipliers,
  pickNeedMultipliers,
  pickPosition,
  qbMarketContext,
  recommendPicks,
  survivalOdds,
  upcomingPicks,
} from "../lib/draftIntel";
import type { QbContext } from "../lib/draftIntel";
import { reviewDraft } from "../lib/draftReview";
import { byeWeekOf } from "../data/byes";
import { buildLlmExport } from "../lib/llmExport";
import { optimizeLineup } from "../lib/lineup";
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
  REDRAFT_GUIDES,
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
const weightsKey = (leagueId: string) => `draft_guide_weights:${leagueId}`;
const shrinkKey = (leagueId: string) => `draft_history_shrink:${leagueId}`;
const rejectedKey = (draftId: string) => `draft_rec_rejected:${draftId}`;
const KINDS: GuideKind[] = ["expert", "projection", "market", "adp", "history"];

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // non-fatal
  }
}

const SOURCE_ICON: Record<string, string> = { bundled: "⚡", live: "📡", sample: "🧪" };

export function Draft() {
  const { bundle, teams, myTeam, values, projPts } = useAppData();
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
  const [weightOverrides, setWeightOverrides] = useState<Record<string, number>>(() => loadJson(weightsKey(leagueId), {}));
  const [editingGuide, setEditingGuide] = useState<string | null>(null);
  const setOverride = (id: string, w: number | null) => {
    const next = { ...weightOverrides };
    if (w == null) delete next[id];
    else next[id] = w;
    setWeightOverrides(next);
    saveJson(weightsKey(leagueId), next);
  };
  const setGuideKind = (id: string, kind: GuideKind) => persist(guidesRef.current.map((g) => (g.id === id ? { ...g, kind } : g)));
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
      // A projection CSV (name + raw stat columns) is scored under this league's
      // rules first; an ADP export becomes an availability guide; anything else
      // is a ranked list.
      const proj = parseProjectionCsv(text);
      if (proj) {
        const entries = projectionCsvEntries(proj, bundle.league.scoring_settings);
        if (entries.length === 0) {
          setImportNote(`"${name}": recognised projection columns (${proj.mapped.join(", ")}) but nothing scored above zero under this league's rules.`);
          return false;
        }
        persist([
          ...guidesRef.current,
          { id: `g${Date.now()}-${Math.floor(Math.random() * 1e6)}`, name, addedAt: Date.now(), entries, source: "user", kind: "projection" },
        ]);
        setImportNote(
          `"${name}": projections for ${entries.length} players scored with your league's scoring (${proj.mapped.length} stat columns${proj.unmapped.length ? `; ignored ${proj.unmapped.join(", ")}` : ""}).`,
        );
        return true;
      }
      const isAdp = parseAdpCsv(text) != null || /\badp\b/i.test(name);
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
        kind: isAdp ? "adp" : inferKind({ name }),
      };
      persist([...guidesRef.current, guide]);
      setImportNote(`"${name}": ${entries.length} players${skipped ? ` (${skipped} lines skipped)` : ""} · ${GUIDE_KIND_LABEL[guide.kind!]} guide`);
      return true;
    },
    [persist, bundle.league.scoring_settings],
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
      const drafts = await sleeper.getLeagueDrafts(leagueId, true);
      const latest = drafts?.[0] ?? null;
      setDraft(latest);
      if (latest) {
        const p = await sleeper.getDraftPicks(latest.draft_id, true);
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
  // Live draft: re-pull picks every 20s so the board, odds and recommendations track the room.
  useEffect(() => {
    if (bundle.demo || draft?.status !== "drafting") return;
    const t = setInterval(() => void loadDraft(), 20_000);
    return () => clearInterval(t);
  }, [bundle.demo, draft?.status, loadDraft]);

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
          kind: inferKind({ name: b.name }),
          scrapedAt: b.scrapedAt ?? BUNDLED_AT,
        })),
      ]);
      if (!quiet) setImportNote(`Loaded ${fresh.length} scraped guide${fresh.length === 1 ? "" : "s"} (${BUNDLED_AT}).`);
      return fresh.length;
    },
    [persist],
  );

  // Bundled multi-platform ADP snapshots (src/data/bundledAdp.ts, written by `npm run scrape`)
  const adpSnapshots = useMemo(() => {
    const { ppr } = { ppr: bundle.league.scoring_settings.rec ?? 0 };
    const fmt = mode === "rookie" ? "rookie" : mode === "startup" ? (sf ? "dynasty_sf" : "dynasty_1qb") : sf ? "2qb" : ppr >= 0.75 ? "ppr" : ppr >= 0.25 ? "half_ppr" : "std";
    return BUNDLED_ADP.filter((b) => b.format === fmt);
  }, [mode, sf, bundle.league.scoring_settings.rec]);
  const loadAdpSnapshots = useCallback(() => {
    const have = new Set(guidesRef.current.map((g) => g.name));
    const fresh = adpSnapshots.filter((b) => !have.has(b.name));
    if (fresh.length === 0) {
      setImportNote("Those ADP snapshots are already loaded.");
      return;
    }
    persist([
      ...guidesRef.current,
      ...fresh.map((b, i) => ({ id: `adp${Date.now()}-${i}`, name: b.name, addedAt: Date.now() + i, entries: b.entries, source: "bundled" as const, kind: "adp" as const, scrapedAt: b.scrapedAt })),
    ]);
    setImportNote(`Loaded ${fresh.length} ADP snapshot${fresh.length === 1 ? "" : "s"}.`);
  }, [adpSnapshots, persist]);

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
          kind: source.kind,
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
    const n = mode === "rookie" ? loadBundled(rookieSet, true) : mode === "startup" ? loadBundled(overallSet, true) : loadBundled(REDRAFT_GUIDES, true);
    const live = liveSourcesFor(mode);
    setImportNote(
      `${n ? `Loaded ${n} bundled ${mode === "rookie" ? "rookie" : mode === "startup" ? "dynasty" : "redraft"} guide${n === 1 ? "" : "s"}` : "No bundled boards for this format"}${
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
  // Two boards from one pile of guides: what a player is WORTH (expert +
  // projection + market) and when he actually GOES (ADP + league history).
  const valueBoard = useMemo(
    () => buildBoard(guides, bundle.players, { kinds: VALUE_KINDS, weights: weightOverrides }),
    [guides, bundle.players, weightOverrides],
  );
  const availBoard = useMemo(
    () => buildBoard(guides, bundle.players, { kinds: AVAILABILITY_KINDS, weights: weightOverrides }),
    [guides, bundle.players, weightOverrides],
  );
  // Nothing on the value side (only ADP loaded)? Show the availability board rather than nothing.
  const board = valueBoard.rows.length > 0 ? valueBoard.rows : availBoard.rows;
  const cpuRank = useMemo(() => new Map(availBoard.rows.map((r) => [r.key, r.consensus])), [availBoard]);
  const warnings = useMemo(() => guideWarnings(guides), [guides]);
  const guideKind = (g: Guide) => inferKind(g);

  // ---- league draft history → how your leaguemates draft ----
  const [history, setHistory] = useState<DraftHistoryBundle | null>(null);
  const [histBusy, setHistBusy] = useState<string | null>(null);
  const [histError, setHistError] = useState<string | null>(null);
  const [shrink, setShrink] = useState<number>(() => loadJson(shrinkKey(leagueId), 2));
  useEffect(() => {
    let cancelled = false;
    if (bundle.demo) return;
    loadCachedHistory(leagueId).then((h) => {
      if (!cancelled && h) setHistory(h);
    });
    return () => {
      cancelled = true;
    };
  }, [leagueId, bundle.demo]);
  const loadHistory = async () => {
    setHistBusy("starting…");
    setHistError(null);
    try {
      const h = await fetchDraftHistory(bundle.league, setHistBusy);
      setHistory(h);
      log.info("draft", `Draft history: ${h.drafts.length} drafts across ${h.chain.length} seasons`);
    } catch (err) {
      setHistError(err instanceof Error ? err.message : String(err));
    } finally {
      setHistBusy(null);
    }
  };
  const currentUserIds = useMemo(() => new Set(bundle.rosters.map((r) => r.owner_id).filter((x): x is string => !!x)), [bundle.rosters]);
  const tendencies = useMemo(
    () => (history && history.drafts.length > 0 ? deriveTendencies(history.drafts, bundle.players, bundle.league.season, currentUserIds) : null),
    [history, bundle.players, bundle.league.season, currentUserIds],
  );
  const rosterOwner = useMemo(() => new Map(bundle.rosters.map((r) => [r.roster_id, r.owner_id])), [bundle.rosters]);
  const priors = useMemo(() => (tendencies ? priorsByRoster(tendencies, rosterOwner, shrink) : undefined), [tendencies, rosterOwner, shrink]);

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
  // Survival odds run over the board as the OTHER teams see it: ADP / history
  // order when we have one, your value board otherwise.
  const availableForOthers = useMemo(() => {
    if (cpuRank.size === 0) return availableRows;
    const key = (r: ConsensusRow) => cpuRank.get(r.key) ?? 1e6 + r.consensus;
    return [...availableRows].sort((a, b) => key(a) - key(b));
  }, [availableRows, cpuRank]);
  const survival = useMemo(
    () =>
      upcoming && upcoming.myNextPick != null
        ? survivalOdds(availableForOthers, upcoming.interveningRosters, needs)
        : null,
    [availableForOthers, upcoming, needs],
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
  // ---- review of the real draft so far ----
  const review = useMemo(() => {
    if (!draft || picks.length === 0) return null;
    const scoreRoster =
      mode === "rookie"
        ? (ids: string[]) => Math.round(ids.reduce((s, id) => s + (values[id]?.value ?? 0), 0))
        : (ids: string[]) => Math.round(optimizeLineup(bundle.league, ids, bundle.players, projPts).totalProjected);
    return reviewDraft(picks, board, bundle.players, bundle.rosters.map((r) => r.roster_id), scoreRoster);
  }, [draft, picks, board, bundle, mode, values, projPts]);
  const teamNameOf = useCallback((rid: number | null) => teams.find((t) => t.rosterId === rid)?.teamName ?? `Roster ${rid}`, [teams]);
  // Bye stacking only matters when the draft builds the season roster.
  const byeCtx = useMemo(() => {
    if (mode === "rookie" || !myTeam) return null;
    const mine = picks
      .filter((p) => p.roster_id === myTeam.rosterId)
      .map((p) => {
        const pl = bundle.players[p.player_id];
        return { name: pl?.last_name ?? pl?.full_name ?? p.player_id, position: pl?.position ?? p.metadata?.position ?? null, bye: byeWeekOf(pl?.team) };
      });
    return { of: (row: ConsensusRow) => (row.sleeperId ? byeWeekOf(bundle.players[row.sleeperId]?.team) : null), mine };
  }, [mode, myTeam, picks, bundle.players]);
  // Steer the recommendations: narrow to a position, or reject a player so the
  // next-best fills in. Rejections stick per draft (this draft only).
  const [recPos, setRecPos] = useState("ALL");
  const [rejected, setRejected] = useState<string[]>(() => (draft ? loadJson<string[]>(rejectedKey(draft.draft_id), []) : []));
  useEffect(() => {
    setRejected(draft ? loadJson<string[]>(rejectedKey(draft.draft_id), []) : []);
  }, [draft?.draft_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const updateRejected = (next: string[]) => {
    setRejected(next);
    if (draft) saveJson(rejectedKey(draft.draft_id), next);
  };
  const recCandidates = useMemo(() => {
    const rej = new Set(rejected);
    return availableRows.filter((r) => !rej.has(r.key) && (recPos === "ALL" || r.position === recPos));
  }, [availableRows, rejected, recPos]);
  const recommended = useMemo(
    () =>
      myTeam && draft && draft.status !== "complete" && recCandidates.length
        ? recommendPicks(recCandidates, needs.get(myTeam.rosterId) ?? {}, survival, { byes: byeCtx })
        : [],
    [recCandidates, needs, survival, myTeam, draft, byeCtx],
  );
  // ---- export the draft results for an LLM ----
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const exportForLlm = async () => {
    if (!review) return;
    const text = buildLlmExport({
      league: bundle.league,
      draft,
      mode,
      myRosterId: myTeam?.rosterId ?? null,
      totalPicks,
      review,
      teamName: teamNameOf,
      byeOf: (id) => byeWeekOf(bundle.players[id]?.team),
      guideNames: guides.map((g) => g.name),
    });
    try {
      await navigator.clipboard.writeText(text);
      setCopyNote(`Copied ${Math.round(text.length / 1000)}k characters — paste into your LLM.`);
    } catch {
      // clipboard blocked: fall back to a download
      const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `draft-results-${bundle.league.season}.md`;
      a.click();
      URL.revokeObjectURL(url);
      setCopyNote("Clipboard blocked — downloaded draft-results.md instead.");
    }
    setTimeout(() => setCopyNote(null), 6000);
  };
  const rejectedStillAvailable = useMemo(() => {
    const rej = new Set(rejected);
    return availableRows.filter((r) => rej.has(r.key));
  }, [availableRows, rejected]);

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
        <StatTile
          label="Guides loaded"
          value={guides.length}
          sub={`${board.length} players · ${valueBoard.nEff} independent value source${valueBoard.nEff === 1 ? "" : "s"}${availBoard.rows.length ? ` · ${availBoard.nEff} availability` : ""}`}
        />
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

      {myTeam && draft && draft.status !== "complete" && availableRows.length > 0 && (
        <div className="card section" style={myTurn ? { borderColor: "var(--delta-up)" } : undefined}>
          <h2>
            {myTurn ? "🎯 Recommended now — you're on the clock" : "🎯 Recommended now"}
            {upcoming?.myNextPick != null && !myTurn && (
              <span className="muted small"> · your next pick is #{upcoming.myNextPick}</span>
            )}
          </h2>
          <div className="pill-row" style={{ marginBottom: 6 }}>
            {posFilters.map((p) => (
              <button key={p} className={recPos === p ? "active" : undefined} onClick={() => setRecPos(p)}>
                {p}
              </button>
            ))}
            {rejectedStillAvailable.length > 0 && (
              <button className="ghost" onClick={() => updateRejected([])} title={rejectedStillAvailable.map((r) => r.displayName).join(", ")}>
                ↩ restore {rejectedStillAvailable.length} rejected
              </button>
            )}
          </div>
          {recommended.length === 0 && <p className="muted small">Nothing left at {recPos} that isn't rejected.</p>}
          <ol className="advice-list">
            {recommended.map((r, i) => (
              <li key={r.row.key}>
                <span className="icon num">{i + 1}</span>
                <button
                  className="ghost"
                  onClick={() => updateRejected([...rejected, r.row.key])}
                  title="Not for me — drop him from the recommendations for this draft"
                  aria-label={`Reject ${r.row.displayName}`}
                  style={{ padding: "0 6px", lineHeight: 1.2 }}
                >
                  ✕
                </button>
                <span>
                  <strong>{r.row.displayName}</strong> {r.row.position && <PosChip pos={r.row.position} />}{" "}
                  <span className="muted small">
                    consensus #{r.row.consensus}
                    {r.need !== 1 && ` · need ×${r.need.toFixed(1)}`}
                    {r.survival != null && ` · ${Math.round(r.survival * 100)}% to last to your next pick`}
                    {r.fallback && ` · if he's gone, ${r.fallback.displayName} (#${r.fallback.consensus}) likely lasts`}
                    {r.bye != null && (
                      <>
                        {" · bye "}
                        {r.byeClashes.length > 0 ? (
                          <span className="delta-down">{r.bye} stacks with {r.byeClashes.join(", ")}</span>
                        ) : (
                          `${r.bye}`
                        )}
                      </>
                    )}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          <p className="muted small" style={{ marginBottom: 0 }}>
            Worth from consensus rank, bent by your positional need, by whether he'd still be there next time you
            pick — a player who will last can wait — and by bye weeks stacking with players you've already taken. {draft?.status === "drafting" ? "Picks re-sync every 20s." : ""}
          </p>
        </div>
      )}

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

      {review && (
        <div className="card section">
          <div className="pill-row" style={{ alignItems: "center", marginBottom: 0 }}>
            <h2 style={{ margin: 0 }}>{draft?.status === "complete" ? "📋 Draft review" : `📋 Draft so far — ${picks.length} picks`}</h2>
            <button
              className="ghost"
              onClick={() => void exportForLlm()}
              title="Copy the draft results as markdown — league format, every roster with pick / consensus / Δ / bye, the strength ranking, and the pick-by-pick list — to paste into ChatGPT, Claude, etc."
              style={{ marginLeft: "auto" }}
            >
              🤖 Copy results for LLM
            </button>
          </div>
          {copyNote && <p className="muted small">{copyNote}</p>}
          <p className="muted small">
            Every pick against your consensus board: Δ = pick number − consensus rank, so +12 means he fell twelve
            spots to that team and −12 means a reach. Teams are ranked by{" "}
            {mode === "rookie" ? "summed dynasty value of their picks" : "projected starting-lineup points from what they've drafted"}
            {review.coverage < 0.9 && ` · ${Math.round(review.coverage * 100)}% of picks are on your board`}.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Team</th>
                  <th className="right">Picks</th>
                  <th className="right" title={mode === "rookie" ? "summed dynasty value" : "projected points from the best lineup of drafted players"}>
                    {mode === "rookie" ? "Value" : "Proj"}
                  </th>
                  <th className="right" title="mean Δ over ranked, non-keeper picks">Avg Δ</th>
                  <th>Mix</th>
                  <th>Best value</th>
                  <th>Biggest reach</th>
                </tr>
              </thead>
              <tbody>
                {review.teams.map((t, i) => (
                  <tr key={t.rosterId} style={t.rosterId === myTeam?.rosterId ? { fontWeight: 600 } : undefined}>
                    <td>{i + 1}</td>
                    <td>{teamNameOf(t.rosterId)}{t.rosterId === myTeam?.rosterId ? " (you)" : ""}</td>
                    <td className="right">{t.picks.length}</td>
                    <td className="right">{t.strength}</td>
                    <td className="right">{t.avgDelta == null ? "—" : `${t.avgDelta > 0 ? "+" : ""}${t.avgDelta.toFixed(1)}`}</td>
                    <td className="muted small">
                      {Object.entries(t.posMix).sort((a, b) => b[1] - a[1]).map(([pos, n]) => `${n} ${pos}`).join(" · ")}
                    </td>
                    <td className="small">{t.bestValue ? `${t.bestValue.name} (+${t.bestValue.delta})` : "—"}</td>
                    <td className="small">{t.biggestReach ? `${t.biggestReach.name} (${t.biggestReach.delta})` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(() => {
            const me = review.teams.find((t) => t.rosterId === myTeam?.rosterId);
            return me && me.picks.length > 0 ? (
              <>
                <h3>Your picks</h3>
                <ul className="advice-list">
                  {me.picks.map((p) => (
                    <li key={p.pickNo}>
                      <span className="icon num muted">R{p.round}.{String(p.slot).padStart(2, "0")}</span>
                      <span>
                        <strong>{p.name}</strong> {p.position && <PosChip pos={p.position} />}{" "}
                        <span className="muted small">
                          pick {p.pickNo}
                          {p.consensus != null ? ` · consensus #${p.consensus} · ` : " · not on your board"}
                          {p.delta != null && (
                            <span className={p.delta >= 0 ? "delta-up" : "delta-down"}>
                              {p.delta > 0 ? `+${p.delta} fell to you` : p.delta < 0 ? `${p.delta} reach` : "on the number"}
                            </span>
                          )}
                          {p.keeper && " · keeper"}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null;
          })()}
          {(review.bestValues.length > 0 || review.biggestReaches.length > 0) && (
            <div className="grid cols-2">
              <div>
                <h3>Best values league-wide</h3>
                <ul className="advice-list">
                  {review.bestValues.map((p) => (
                    <li key={p.pickNo}>
                      <span className="icon">💎</span>
                      <span>
                        <strong>{p.name}</strong> {p.position && <PosChip pos={p.position} />}{" "}
                        <span className="muted small">+{p.delta} · pick {p.pickNo} vs #{p.consensus} · {teamNameOf(p.rosterId)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>Biggest reaches</h3>
                <ul className="advice-list">
                  {review.biggestReaches.map((p) => (
                    <li key={p.pickNo}>
                      <span className="icon">🙈</span>
                      <span>
                        <strong>{p.name}</strong> {p.position && <PosChip pos={p.position} />}{" "}
                        <span className="muted small">{p.delta} · pick {p.pickNo} vs #{p.consensus} · {teamNameOf(p.rosterId)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="card section">
        <h2>Draft guides</h2>
        <p className="muted small">
          Feed it every guide you can find — CSV, spreadsheet paste, or a ranked list copied out of
          a PDF ("12. Player Name", tiers welcome). Each source becomes a column in the consensus, weighted by
          breadth (a 100-expert consensus outweighs one analyst; an analyst already inside it counts half). ADP
          exports and projection CSVs are detected on upload and become availability / projection guides.
          {mode === "redraft"
            ? ` PFF's 2026 redraft cheat sheet (${REDRAFT_GUIDES[0]?.scrapedAt ?? BUNDLED_AT}) is bundled and loads automatically; live feeds (FantasyCalc redraft values, Sleeper's own ADP) are matched to this league's scoring and QB format. The dynasty boards stay out of the way here.`
            : ` Boards scraped ${BUNDLED_AT} (FantasyPros ECR, KeepTradeCut, CBS, Matthew Berry) are bundled and load the ${sf ? "superflex" : "1QB"} versions automatically; live FantasyCalc rankings and Sleeper ADP refresh on demand.`}
        </p>
        {guides.length > 0 && (
          <div className="guide-list">
            {guides.map((g) => {
              const kind = guideKind(g);
              const w = guideWeight(g, guides, weightOverrides);
              const overridden = weightOverrides[g.id] != null;
              return (
                <span
                  key={g.id}
                  className={`guide-chip kind-${kind}${g.source ? ` ${g.source}` : ""}${editingGuide === g.id ? " editing" : ""}`}
                  title={`${GUIDE_KIND_LABEL[kind]} guide · weight ${w}${overridden ? " (yours)" : " (default)"} · click to edit`}
                  onClick={() => setEditingGuide(editingGuide === g.id ? null : g.id)}
                >
                  {g.source && SOURCE_ICON[g.source] && <span>{SOURCE_ICON[g.source]}</span>}
                  <strong>{g.name}</strong>
                  <span className="muted small"> · {g.entries.length}</span>
                  <span className={`kind-tag${w === 0 ? " off" : ""}`}>{GUIDE_KIND_LABEL[kind]} · ×{w}</span>
                  <button onClick={(e) => { e.stopPropagation(); removeGuide(g.id); }} title="Remove guide">✕</button>
                </span>
              );
            })}
          </div>
        )}
        {editingGuide && guides.some((g) => g.id === editingGuide) && (() => {
          const g = guides.find((x) => x.id === editingGuide)!;
          const w = guideWeight(g, guides, weightOverrides);
          return (
            <div className="guide-editor">
              <strong>{g.name}</strong>
              <label className="muted small">
                kind{" "}
                <select value={guideKind(g)} onChange={(e) => setGuideKind(g.id, e.target.value as GuideKind)}>
                  {KINDS.map((k) => (
                    <option key={k} value={k}>{GUIDE_KIND_LABEL[k]}</option>
                  ))}
                </select>
              </label>
              <label className="muted small">
                weight{" "}
                <input
                  type="number"
                  min={0}
                  max={10}
                  step={0.5}
                  value={w}
                  onChange={(e) => setOverride(g.id, Math.max(0, Math.min(10, Number(e.target.value) || 0)))}
                  style={{ width: 64 }}
                />
              </label>
              {weightOverrides[g.id] != null && (
                <button className="linklike small" onClick={() => setOverride(g.id, null)}>reset to default</button>
              )}
              <span className="muted small">
                Expert / projection / market guides build the value board; ADP and league history build the availability
                board the CPU teams draft off. Weight 0 mutes a guide without removing it.
              </span>
            </div>
          );
        })()}
        {warnings.length > 0 && (
          <ul className="advice-list small" style={{ marginBottom: 10 }}>
            {warnings.map((w, i) => (
              <li key={i}>
                <span className="icon">⚖️</span>
                <span className="muted">{w.message}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="pill-row" style={{ marginBottom: 0 }}>
          {mode === "redraft" && (
            <button
              onClick={() => loadBundled(REDRAFT_GUIDES)}
              title={REDRAFT_GUIDES.map((g) => `${g.name} (${g.scrapedAt ?? BUNDLED_AT})`).join(", ")}
            >
              ⚡ Redraft guides ({REDRAFT_GUIDES.length})
            </button>
          )}
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
          {adpSnapshots.length > 0 && (
            <button onClick={loadAdpSnapshots} title={adpSnapshots.map((b) => `${b.name} (${b.scrapedAt})`).join(", ")}>
              📦 ADP snapshots ({adpSnapshots.length})
            </button>
          )}
          <button onClick={() => fileRef.current?.click()} title="Ranked lists, ADP exports (Underdog/NFFC/DLF), or projection CSVs — all detected automatically">
            📄 Upload files
          </button>
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

      {!bundle.demo && (
        <div className="card section">
          <h2>How your leaguemates draft</h2>
          <p className="muted small">
            This league's own past drafts (walked back through previous seasons), attributed to the <em>person</em>, not
            the roster slot. Each owner's tendencies bend their CPU team in the mock and the "Lasts %" odds; with 1–3
            drafts of evidence they're shrunk toward the league-wide pattern.
          </p>
          <div className="pill-row" style={{ alignItems: "center" }}>
            <button className={history ? "" : "active"} onClick={() => void loadHistory()} disabled={histBusy != null}>
              {histBusy ? `⏳ ${histBusy}` : history ? "↻ Reload history" : "📜 Load league draft history"}
            </button>
            {history && (
              <span className="muted small">
                {history.drafts.length} draft{history.drafts.length === 1 ? "" : "s"} across {history.chain.length} season
                {history.chain.length === 1 ? "" : "s"}
                {tendencies && tendencies.league.reach == null ? " · no Sleeper ADP for those seasons, so reach isn't measured" : ""}
              </span>
            )}
            {tendencies && (
              <label className="muted small" title="Pseudo-drafts of league-average evidence mixed into each owner: 0 trusts their record fully, 6 barely moves off the league prior">
                shrinkage{" "}
                <input type="range" min={0} max={6} step={1} value={shrink} onChange={(e) => { setShrink(Number(e.target.value)); saveJson(shrinkKey(leagueId), Number(e.target.value)); }} />{" "}
                <span className="num">{shrink}</span>
              </label>
            )}
          </div>
          {histError && <div className="error-box">{histError}</div>}
          {tendencies && priors && (
            <div className="table-wrap">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Team</th>
                    <th className="right" title="drafts on record for this owner">Drafts</th>
                    <th className="right" title="median round of the owner's first QB">1st QB</th>
                    <th className="right" title="median round of the owner's first TE">1st TE</th>
                    <th className="right" title="RB share of RB+WR picks in the first third of the draft">RB early</th>
                    <th className="right" title="mean rounds ahead of Sleeper ADP the owner takes players (+ = reaches)">Reach</th>
                    {mode !== "rookie" && <th className="right" title="share of full-roster-draft picks spent on rookies">Rookies</th>}
                    <th>Reads as (after shrinkage)</th>
                  </tr>
                </thead>
                <tbody>
                  {teams.map((t) => {
                    const own = t.ownerId ? tendencies.owners.get(t.ownerId) : undefined;
                    const p = priors.get(t.rosterId);
                    const rounds = defaultRounds(mode, bundle.league, draft);
                    const rnd = (frac: number | null | undefined) => (frac == null ? "—" : `R${Math.max(1, Math.round(frac * rounds + 0.5))}`);
                    const pct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);
                    return (
                      <tr key={t.rosterId} className={t.isMine ? "mine" : ""}>
                        <td><strong>{t.teamName}</strong>{t.isMine && <span className="small" style={{ color: "var(--s5-aqua)" }}> ← you</span>}</td>
                        <td className="right num">{own?.drafts ?? 0}</td>
                        <td className="right num">{rnd(own?.firstQb)}</td>
                        <td className="right num">{rnd(own?.firstTe)}</td>
                        <td className="right num">{pct(own?.rbShareEarly)}</td>
                        <td className={`right num${own?.reach != null && own.reach > 0.5 ? " delta-up" : own?.reach != null && own.reach < -0.5 ? " delta-down" : ""}`}>
                          {own?.reach == null ? "—" : `${own.reach > 0 ? "+" : ""}${own.reach.toFixed(1)}`}
                        </td>
                        {mode !== "rookie" && <td className="right num">{pct(own?.rookieShare)}</td>}
                        <td className="muted small">{p ? describePrior(p).join(" · ") || (own ? "league-average drafter" : "no history — league prior") : ""}</td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td className="muted">League</td>
                    <td className="right num muted">{tendencies.drafts}</td>
                    <td className="right num muted">{tendencies.league.firstQb == null ? "—" : `R${Math.max(1, Math.round(tendencies.league.firstQb * defaultRounds(mode, bundle.league, draft) + 0.5))}`}</td>
                    <td className="right num muted">{tendencies.league.firstTe == null ? "—" : `R${Math.max(1, Math.round(tendencies.league.firstTe * defaultRounds(mode, bundle.league, draft) + 0.5))}`}</td>
                    <td className="right num muted">{tendencies.league.rbShareEarly == null ? "—" : `${Math.round(tendencies.league.rbShareEarly * 100)}%`}</td>
                    <td className="right num muted">{tendencies.league.reach == null ? "—" : tendencies.league.reach.toFixed(1)}</td>
                    {mode !== "rookie" && <td className="right num muted">{tendencies.league.rookieShare == null ? "—" : `${Math.round(tendencies.league.rookieShare * 100)}%`}</td>}
                    <td className="muted small">the prior every owner is shrunk toward</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          {history && history.drafts.length === 0 && <p className="muted">No completed drafts found in this league's history.</p>}
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
        cpuRank={cpuRank}
        tendencies={priors}
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
