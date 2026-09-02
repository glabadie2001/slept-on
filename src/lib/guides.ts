import { normalizeName } from "../api/marketValues";
import type { PlayerMap } from "../types";

/**
 * Draft guide aggregation: turn any pile of pasted/uploaded ranking lists into
 * one consensus board. Parsing is deliberately forgiving — guides come from
 * PDFs, spreadsheets, and blog posts, and they all format differently.
 */

export interface GuideEntry {
  name: string;
  rank: number;
  tier: number | null;
  position: string | null;
}

export type GuideSource = "user" | "bundled" | "live" | "sample";

export interface Guide {
  id: string;
  name: string;
  addedAt: number;
  entries: GuideEntry[];
  /** where it came from (absent on guides stored before this field existed = user) */
  source?: GuideSource;
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

/**
 * Parse one guide's text. Handles, per line:
 *   "1. Ashton Jeanty, RB, LV"   "Ashton Jeanty\tRB"   "12,Ashton Jeanty,RB"
 *   bare names (implicit order), "Tier 2" headers, csv header rows.
 */
export function parseGuide(text: string): { entries: GuideEntry[]; skipped: number } {
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
        position ??= field.toUpperCase().replace(/\d+$/, "").replace(/[.,;]$/, "");
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
            position ??= w.toUpperCase().replace(/\d+$/, "");
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

// ---------- Aggregation ----------

export interface ConsensusRow {
  /** normalized-name key */
  key: string;
  displayName: string;
  sleeperId: string | null;
  position: string | null;
  /** guideId -> rank in that guide */
  ranks: Record<string, number>;
  avg: number;
  best: number;
  worst: number;
  /** stdev of ranks across guides that list the player */
  sd: number;
  /** best (lowest) tier any guide assigns */
  tier: number | null;
  count: number;
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

export function aggregateGuides(guides: Guide[], players: PlayerMap): ConsensusRow[] {
  const nameIndex = buildNameIndex(players);
  const byKey = new Map<string, Omit<ConsensusRow, "avg" | "best" | "worst" | "sd" | "count" | "consensus">>();

  for (const guide of guides) {
    for (const entry of guide.entries) {
      const key = normalizeName(entry.name);
      if (!key) continue;
      let row = byKey.get(key);
      if (!row) {
        const sleeperId = nameIndex.get(key) ?? null;
        row = {
          key,
          displayName: entry.name,
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

  const rows = [...byKey.values()].map((row) => {
    const ranks = Object.values(row.ranks);
    const avg = ranks.reduce((s, r) => s + r, 0) / ranks.length;
    const sd =
      ranks.length > 1
        ? Math.sqrt(ranks.reduce((s, r) => s + (r - avg) ** 2, 0) / ranks.length)
        : 0;
    return {
      ...row,
      avg: Math.round(avg * 10) / 10,
      best: Math.min(...ranks),
      worst: Math.max(...ranks),
      sd: Math.round(sd * 10) / 10,
      count: ranks.length,
      consensus: 0,
    };
  });

  // Consensus order: avg rank, then breadth (in more guides = more trusted), then best rank.
  rows.sort((a, b) => a.avg - b.avg || b.count - a.count || a.best - b.best);
  rows.forEach((r, i) => (r.consensus = i + 1));
  return rows;
}
