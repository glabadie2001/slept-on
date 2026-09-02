import { normalizeName } from "../api/marketValues";
import type { PlayerMap } from "../types";

/**
 * Draft guide aggregation: turn any pile of pasted/uploaded ranking lists into
 * one consensus board. Parsing is deliberately forgiving — guides come from
 * PDFs, spreadsheets, and blog posts, and they all format differently.
 *
 * Two boards come out of the same guides:
 *  - the VALUE board (expert + projection + market kinds): what a player is worth
 *  - the AVAILABILITY board (adp + league-history kinds): when he actually goes
 * Guides are weighted by breadth (an expert consensus counts for more than one
 * analyst, and an analyst already inside that consensus counts for less) and
 * every row reports the effective number of independent sources behind it.
 */

export interface GuideEntry {
  name: string;
  rank: number;
  tier: number | null;
  position: string | null;
  /** exact join when the source exposes it (bundled/live feeds); name-matched otherwise */
  sleeperId?: string | null;
}

export type GuideSource = "user" | "bundled" | "live" | "sample";

/**
 * What question a guide answers:
 *  expert     analyst opinion of worth (rankings, tiers)
 *  projection model-based worth (raw stat projections scored with league rules)
 *  market     crowd trade prices (KTC, FantasyCalc) — worth, not timing
 *  adp        where real drafters take him — timing
 *  history    this league's own drafters — timing
 */
export type GuideKind = "expert" | "projection" | "market" | "adp" | "history";

export const VALUE_KINDS: GuideKind[] = ["expert", "projection", "market"];
export const AVAILABILITY_KINDS: GuideKind[] = ["adp", "history"];

export const GUIDE_KIND_LABEL: Record<GuideKind, string> = {
  expert: "expert",
  projection: "projection",
  market: "market",
  adp: "ADP",
  history: "league history",
};

export interface Guide {
  id: string;
  name: string;
  addedAt: number;
  entries: GuideEntry[];
  /** where it came from (absent on guides stored before this field existed = user) */
  source?: GuideSource;
  /** what it measures; inferred from the name when absent */
  kind?: GuideKind;
  /** user override of the default breadth weight */
  weight?: number;
  /** when a bundled snapshot was scraped (ISO date) */
  scrapedAt?: string;
}

// ---------- kinds & weights ----------

/** best guess at a guide's kind from its name, for guides stored before `kind` existed */
export function inferKind(guide: Pick<Guide, "name" | "kind">): GuideKind {
  if (guide.kind) return guide.kind;
  const n = guide.name;
  if (/\badp\b/i.test(n)) return "adp";
  if (/keeptradecut|\bktc\b|fantasycalc|dynastyprocess|market|trade value/i.test(n)) return "market";
  if (/projection|\bproj\b/i.test(n)) return "projection";
  if (/league history|leaguemates/i.test(n)) return "history";
  return "expert";
}

/** an expert consensus (many analysts averaged) rather than one voice */
export function isConsensusBoard(name: string): boolean {
  return /\becr\b|consensus|expert consensus|fantasypros/i.test(name);
}

/**
 * Analysts / outlets whose rankings are already averaged into FantasyPros ECR.
 * Loading one of them alongside ECR double-counts that voice. Approximate list;
 * matched against the guide name.
 */
export const ECR_CONTRIBUTORS: RegExp[] = [
  /\bcbs\b/i,
  /heath cummings/i,
  /dave richard/i,
  /jamey eisenberg/i,
  /matthew berry/i,
  /fantasy life/i,
  /\bespn\b/i,
  /\byahoo\b/i,
  /\bnbc\b|rotoworld|rotowire/i,
  /\bpff\b|pro football focus/i,
  /the athletic/i,
  /footballguys/i,
  /4for4/i,
  /numberfire/i,
  /fantasy footballers/i,
  /dynasty league football|\bdlf\b/i,
  /dynasty nerds/i,
  /draft sharks/i,
  /fftoday/i,
  /walter football/i,
];

export function insideEcr(name: string): boolean {
  return !isConsensusBoard(name) && ECR_CONTRIBUTORS.some((re) => re.test(name));
}

/**
 * Default breadth weight. Consensus boards carry many voices; a single analyst
 * is one voice, and half a voice when a consensus that already contains them
 * is also loaded. Market prices are one crowd each but two of them are near
 * collinear, so they split a shared budget. Projections are a model, not an
 * opinion — one full independent signal.
 */
export function defaultWeight(guide: Guide, all: Guide[]): number {
  const kind = inferKind(guide);
  switch (kind) {
    case "expert": {
      if (isConsensusBoard(guide.name)) return 3;
      const consensusLoaded = all.some((g) => g.id !== guide.id && inferKind(g) === "expert" && isConsensusBoard(g.name));
      return consensusLoaded && insideEcr(guide.name) ? 0.5 : 1;
    }
    case "market": {
      const markets = all.filter((g) => inferKind(g) === "market").length;
      return markets > 1 ? 1.5 / markets : 1.5;
    }
    case "projection":
      return 1.5;
    case "adp":
      return 1.5;
    case "history":
      return 1;
  }
}

export function guideWeight(guide: Guide, all: Guide[], overrides?: Record<string, number>): number {
  const o = overrides?.[guide.id];
  if (o != null && Number.isFinite(o)) return Math.max(0, o);
  if (guide.weight != null && Number.isFinite(guide.weight)) return Math.max(0, guide.weight);
  return defaultWeight(guide, all);
}

/** (Σw)² / Σw²: how many equally-weighted independent sources these weights amount to */
export function effectiveSources(weights: number[]): number {
  const s = weights.reduce((a, w) => a + w, 0);
  const ss = weights.reduce((a, w) => a + w * w, 0);
  return ss > 0 ? Math.round(((s * s) / ss) * 10) / 10 : 0;
}

export interface GuideWarning {
  guideId: string;
  message: string;
}

/** things the user should know about how the loaded guides overlap */
export function guideWarnings(guides: Guide[]): GuideWarning[] {
  const out: GuideWarning[] = [];
  const consensus = guides.filter((g) => inferKind(g) === "expert" && isConsensusBoard(g.name));
  if (consensus.length > 0) {
    for (const g of guides) {
      if (inferKind(g) === "expert" && insideEcr(g.name)) {
        out.push({ guideId: g.id, message: `${g.name} is already averaged into ${consensus[0].name} — weighted at half a voice.` });
      }
    }
  }
  const markets = guides.filter((g) => inferKind(g) === "market");
  if (markets.length > 1) {
    out.push({ guideId: markets[1].id, message: `${markets.map((m) => m.name).join(" and ")} are both crowd trade prices and move together — they share one market weight.` });
  }
  return out;
}

const POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DEF", "DST", "PK"]);
const NFL_TEAMS = new Set([
  "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET",
  "GB", "HOU", "IND", "JAX", "JAC", "KC", "LAC", "LAR", "LA", "LV", "MIA",
  "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS",
]);

/** "WR3", "RB12" → "WR"; bare team/pos codes pass through */
function tokenKind(token: string): "position" | "team" | null {
  const t = token.toUpperCase().replace(/[.,;]$/, "");
  const posMatch = /^([A-Z]{1,3})\d{0,2}$/.exec(t);
  if (posMatch && POSITIONS.has(posMatch[1])) return "position";
  if (NFL_TEAMS.has(t)) return "team";
  return null;
}

const normPos = (p: string): string => {
  const u = p.toUpperCase().replace(/\d+$/, "").replace(/[.,;]$/, "");
  return u === "DST" ? "DEF" : u === "PK" ? "K" : u;
};

/**
 * Parse one guide's text. Handles, per line:
 *   "1. Ashton Jeanty, RB, LV"   "Ashton Jeanty\tRB"   "12,Ashton Jeanty,RB"
 *   bare names (implicit order), "Tier 2" headers, csv header rows.
 * CSVs with a header that names an ADP column and/or split first/last name
 * columns (Underdog, NFFC, DLF exports) are routed to parseAdpCsv.
 */
export function parseGuide(text: string): { entries: GuideEntry[]; skipped: number } {
  const adp = parseAdpCsv(text);
  if (adp) return adp;

  const entries: GuideEntry[] = [];
  let skipped = 0;
  let currentTier: number | null = null;
  let sawHeader = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const tierMatch = /^tier\s+(\d{1,2})\b/i.exec(line);
    if (tierMatch) {
      currentTier = parseInt(tierMatch[1], 10);
      continue;
    }

    // Header row (once, near the top): "Rank, Player, Pos" etc.
    if (!sawHeader && entries.length === 0 && /\b(rank|player|name)\b/i.test(line) && !/\d/.test(line)) {
      sawHeader = true;
      continue;
    }

    const fields = line.split(/[\t,;]+/).map((f) => f.trim()).filter(Boolean);
    let rank: number | null = null;
    let position: string | null = null;
    const nameTokens: string[] = [];

    for (const field of fields) {
      // pure number field = rank (first one wins); "9999"-style values are too big
      if (/^\d{1,3}$/.test(field) && rank == null && nameTokens.length === 0) {
        rank = parseInt(field, 10);
        continue;
      }
      const kind = tokenKind(field);
      if (kind === "position") {
        position ??= normPos(field);
        continue;
      }
      if (kind === "team") continue;
      if (nameTokens.length === 0) {
        // strip a "12." / "12)" rank prefix riding on the name field
        const m = /^(\d{1,3})[.)]\s+(.*)$/.exec(field);
        let f = field;
        if (m) {
          if (rank == null) rank = parseInt(m[1], 10);
          f = m[2];
        }
        // whitespace-separated line: peel trailing pos/team tokens off the name
        const words = f.split(/\s+/);
        while (words.length > 1) {
          const kindLast = tokenKind(words[words.length - 1]);
          if (kindLast === "position") {
            const w = words.pop()!;
            position ??= normPos(w);
          } else if (kindLast === "team") {
            words.pop();
          } else break;
        }
        const name = words.join(" ").replace(/\((.*?)\)/g, "").trim();
        if (name) nameTokens.push(name);
      }
    }

    const name = nameTokens[0];
    if (!name || !/[a-z]/i.test(name)) {
      skipped++;
      continue;
    }
    entries.push({
      name,
      rank: rank ?? entries.length + 1,
      tier: currentTier,
      position,
    });
  }
  return { entries, skipped };
}

// ---------- ADP-style CSV (Underdog / NFFC / DLF exports) ----------

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if ((c === "," || c === "\t" || c === ";") && !quoted) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * A CSV whose header names an ADP (or average pick) column, with either a
 * single name column or first/last name columns. Rows are ordered by ADP; the
 * emitted rank is the ADP order (1-based), so ties and gaps in ADP are fine.
 * Returns null when the text isn't such a CSV so parseGuide can carry on.
 */
export function parseAdpCsv(text: string): { entries: GuideEntry[]; skipped: number } | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return null;
  const header = splitCsvLine(lines[0]).map(norm);
  const find = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const adpIdx = find("adp", "averagepick", "avgpick", "average", "avg", "adpoverall", "overalladp", "mockadp");
  const firstIdx = find("firstname", "first");
  const lastIdx = find("lastname", "last");
  const nameIdx = find("name", "player", "playername", "fullname");
  if (adpIdx < 0 || (nameIdx < 0 && (firstIdx < 0 || lastIdx < 0))) return null;
  const posIdx = find("position", "pos", "slotname", "slot");
  const idIdx = find("sleeperid", "sleeper", "sleeperplayerid");

  const rows: { name: string; adp: number; position: string | null; sleeperId: string | null }[] = [];
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const f = splitCsvLine(line);
    const name = nameIdx >= 0 ? f[nameIdx] : `${f[firstIdx] ?? ""} ${f[lastIdx] ?? ""}`.trim();
    const adp = parseFloat((f[adpIdx] ?? "").replace(/[^0-9.]/g, ""));
    if (!name || !/[a-z]/i.test(name) || !Number.isFinite(adp) || adp <= 0) {
      skipped++;
      continue;
    }
    const rawPos = posIdx >= 0 ? f[posIdx] : "";
    const position = rawPos && tokenKind(rawPos) === "position" ? normPos(rawPos) : null;
    rows.push({ name, adp, position, sleeperId: idIdx >= 0 && f[idIdx] ? f[idIdx] : null });
  }
  rows.sort((a, b) => a.adp - b.adp);
  return {
    entries: rows.map((r, i) => ({ name: r.name, rank: i + 1, tier: null, position: r.position, sleeperId: r.sleeperId })),
    skipped,
  };
}

// ---------- Aggregation ----------

export interface ConsensusRow {
  /** normalized-name key */
  key: string;
  displayName: string;
  sleeperId: string | null;
  position: string | null;
  /** guideId -> rank in that guide */
  ranks: Record<string, number>;
  /** weighted average rank */
  avg: number;
  best: number;
  worst: number;
  /** weighted stdev of ranks across guides that list the player */
  sd: number;
  /** best (lowest) tier any guide assigns */
  tier: number | null;
  count: number;
  /** effective number of independent sources behind this row */
  nEff: number;
  /** 1-based position on the consensus board */
  consensus: number;
}

export function buildNameIndex(players: PlayerMap): Map<string, string> {
  const byName = new Map<string, string>();
  for (const [id, p] of Object.entries(players)) {
    const name = p.full_name ?? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim();
    if (!name) continue;
    const key = normalizeName(name);
    const prev = byName.get(key);
    if (prev == null || (p.search_rank ?? 1e9) < (players[prev]?.search_rank ?? 1e9)) {
      byName.set(key, id);
    }
  }
  return byName;
}

export interface AggregateOptions {
  /** only these kinds take part (default: all loaded guides) */
  kinds?: GuideKind[];
  /** per-guide weight overrides (guide id → weight) */
  weights?: Record<string, number>;
  /** ignore breadth weighting and count every guide once */
  equal?: boolean;
}

export interface Board {
  rows: ConsensusRow[];
  /** guides that took part, with the weight each carried */
  guides: { guide: Guide; weight: number }[];
  /** effective independent sources across the whole board */
  nEff: number;
}

export function aggregateGuides(guides: Guide[], players: PlayerMap, opts: AggregateOptions = {}): ConsensusRow[] {
  return buildBoard(guides, players, opts).rows;
}

export function buildBoard(guides: Guide[], players: PlayerMap, opts: AggregateOptions = {}): Board {
  const included = guides.filter((g) => !opts.kinds || opts.kinds.includes(inferKind(g)));
  const weighted = included
    .map((guide) => ({ guide, weight: opts.equal ? 1 : guideWeight(guide, guides, opts.weights) }))
    .filter((g) => g.weight > 0);
  const weightOf = new Map(weighted.map((g) => [g.guide.id, g.weight]));

  const nameIndex = buildNameIndex(players);
  type Partial = Omit<ConsensusRow, "avg" | "best" | "worst" | "sd" | "count" | "consensus" | "nEff">;
  const byKey = new Map<string, Partial>();

  for (const { guide } of weighted) {
    for (const entry of guide.entries) {
      // Prefer the source's own Sleeper id; else the player's canonical name so
      // spelling variants across guides collapse onto one row.
      const idFromEntry = entry.sleeperId && players[entry.sleeperId] ? entry.sleeperId : null;
      const canonical = idFromEntry
        ? players[idFromEntry].full_name ?? `${players[idFromEntry].first_name ?? ""} ${players[idFromEntry].last_name ?? ""}`.trim()
        : entry.name;
      const key = normalizeName(canonical || entry.name);
      if (!key) continue;
      let row = byKey.get(key);
      if (!row) {
        const sleeperId = idFromEntry ?? nameIndex.get(key) ?? null;
        row = {
          key,
          displayName: canonical || entry.name,
          sleeperId,
          position: sleeperId ? (players[sleeperId].position ?? entry.position) : entry.position,
          ranks: {},
          tier: entry.tier,
        };
        byKey.set(key, row);
      }
      // Duplicate names within a guide: keep the better (lower) rank.
      const existing = row.ranks[guide.id];
      if (existing == null || entry.rank < existing) row.ranks[guide.id] = entry.rank;
      if (entry.tier != null && (row.tier == null || entry.tier < row.tier)) row.tier = entry.tier;
      if (row.position == null && entry.position != null) row.position = entry.position;
    }
  }

  const rows: ConsensusRow[] = [...byKey.values()].map((row) => {
    const pairs = Object.entries(row.ranks).map(([gid, r]) => ({ r, w: weightOf.get(gid) ?? 0 }));
    const wsum = pairs.reduce((s, p) => s + p.w, 0) || 1;
    const avg = pairs.reduce((s, p) => s + p.r * p.w, 0) / wsum;
    const sd =
      pairs.length > 1
        ? Math.sqrt(pairs.reduce((s, p) => s + p.w * (p.r - avg) ** 2, 0) / wsum)
        : 0;
    const ranks = pairs.map((p) => p.r);
    return {
      ...row,
      avg: Math.round(avg * 10) / 10,
      best: Math.min(...ranks),
      worst: Math.max(...ranks),
      sd: Math.round(sd * 10) / 10,
      count: ranks.length,
      nEff: effectiveSources(pairs.map((p) => p.w)),
      consensus: 0,
    };
  });

  // Consensus order: avg rank, then breadth (more independent sources = more trusted), then best rank.
  rows.sort((a, b) => a.avg - b.avg || b.nEff - a.nEff || b.count - a.count || a.best - b.best);
  rows.forEach((r, i) => (r.consensus = i + 1));
  return { rows, guides: weighted, nEff: effectiveSources(weighted.map((g) => g.weight)) };
}
