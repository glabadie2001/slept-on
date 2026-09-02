import type { GuideEntry } from "./guides";
import { scoreStatLine } from "./scoring";
import type { PlayerMap, ProjectionRow, StatLine } from "../types";

/**
 * Projections as a guide kind: raw season stat lines → points under the
 * league's actual scoring → a ranked board. Exact for custom scoring (TE
 * premium, 6-pt passing TDs, first-down bonuses…) and independent of expert
 * opinion.
 *
 * Sources: Sleeper's own season projections (browser-reachable, keyed by
 * player_id), and uploaded CSVs from FantasyPros / 4for4 / Footballguys-style
 * exports, whose column names we map onto Sleeper stat keys.
 */

const SKILL = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

export interface ProjectedPlayer {
  playerId: string | null;
  name: string;
  position: string | null;
  stats: StatLine;
  points: number;
}

/** Sleeper season projection rows → scored, ranked, Sleeper-id-joined entries */
export function sleeperProjectionEntries(
  rows: ProjectionRow[],
  scoring: Record<string, number>,
  players: PlayerMap,
  max = 400,
): GuideEntry[] {
  const scored: ProjectedPlayer[] = [];
  for (const r of rows) {
    if (!r.player_id || !r.stats) continue;
    const p = players[r.player_id];
    if (!p || !p.position || !SKILL.has(p.position)) continue;
    const points = scoreStatLine(r.stats, scoring);
    if (points <= 0) continue;
    scored.push({
      playerId: r.player_id,
      name: p.full_name ?? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim(),
      position: p.position,
      stats: r.stats,
      points,
    });
  }
  scored.sort((a, b) => b.points - a.points);
  return scored.slice(0, max).map((s, i) => ({
    name: s.name,
    rank: i + 1,
    tier: null,
    position: s.position,
    sleeperId: s.playerId,
  }));
}

// ---------- projection CSV upload ----------

/** header aliases → Sleeper stat keys (lowercased, punctuation stripped) */
const STAT_COLUMNS: Record<string, string> = {
  passyds: "pass_yd", passyd: "pass_yd", passingyards: "pass_yd", passyards: "pass_yd", pyds: "pass_yd", payds: "pass_yd",
  passtd: "pass_td", passtds: "pass_td", passingtds: "pass_td", ptd: "pass_td", patd: "pass_td",
  int: "pass_int", ints: "pass_int", passint: "pass_int", interceptions: "pass_int",
  passatt: "pass_att", att: "pass_att", passcmp: "pass_cmp", cmp: "pass_cmp",
  rushyds: "rush_yd", rushyd: "rush_yd", rushingyards: "rush_yd", rushyards: "rush_yd", ruyds: "rush_yd",
  rushtd: "rush_td", rushtds: "rush_td", rushingtds: "rush_td", rutd: "rush_td",
  rushatt: "rush_att", carries: "rush_att", ruatt: "rush_att",
  rec: "rec", receptions: "rec", recs: "rec",
  recyds: "rec_yd", recyd: "rec_yd", receivingyards: "rec_yd", recyards: "rec_yd", reyds: "rec_yd",
  rectd: "rec_td", rectds: "rec_td", receivingtds: "rec_td", retd: "rec_td",
  tgt: "rec_tgt", targets: "rec_tgt",
  fum: "fum_lost", fl: "fum_lost", fumbles: "fum_lost", fumlost: "fum_lost", fumbleslost: "fum_lost",
  fg: "fgm", fgm: "fgm", fgmade: "fgm", xp: "xpm", xpm: "xpm", xpmade: "xpm", pat: "xpm",
  sack: "sack", sacks: "sack", defint: "int", deftd: "def_td", safety: "safe", safeties: "safe",
  fumrec: "fum_rec", ff: "ff", blkkick: "blk_kick",
  gp: "gp", g: "gp", games: "gp",
};
const NAME_COLUMNS = new Set(["player", "name", "playername", "fullname"]);
const POS_COLUMNS = new Set(["pos", "position"]);
const TEAM_COLUMNS = new Set(["team", "tm"]);

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

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

export interface ProjectionCsv {
  players: { name: string; position: string | null; team: string | null; stats: StatLine }[];
  /** stat columns we recognised, as Sleeper keys */
  mapped: string[];
  /** header columns we ignored */
  unmapped: string[];
}

/** does this text look like a projection CSV (a name column plus ≥2 stat columns)? */
export function parseProjectionCsv(text: string): ProjectionCsv | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return null;
  const header = splitCsvLine(lines[0]);
  const keys = header.map(norm);
  const nameIdx = keys.findIndex((k) => NAME_COLUMNS.has(k));
  if (nameIdx < 0) return null;
  const posIdx = keys.findIndex((k) => POS_COLUMNS.has(k));
  const teamIdx = keys.findIndex((k) => TEAM_COLUMNS.has(k));
  const statIdx: { idx: number; key: string }[] = [];
  const unmapped: string[] = [];
  keys.forEach((k, i) => {
    if (i === nameIdx || i === posIdx || i === teamIdx) return;
    const stat = STAT_COLUMNS[k];
    if (stat) statIdx.push({ idx: i, key: stat });
    else unmapped.push(header[i]);
  });
  if (statIdx.length < 2) return null;

  const players: ProjectionCsv["players"] = [];
  for (const line of lines.slice(1)) {
    const f = splitCsvLine(line);
    const name = (f[nameIdx] ?? "").replace(/\((.*?)\)/g, "").trim();
    if (!name || !/[a-z]/i.test(name)) continue;
    const stats: StatLine = {};
    for (const { idx, key } of statIdx) {
      const v = parseFloat((f[idx] ?? "").replace(/,/g, ""));
      if (Number.isFinite(v)) stats[key] = (stats[key] ?? 0) + v;
    }
    const rawPos = posIdx >= 0 ? (f[posIdx] ?? "").toUpperCase().replace(/\d+$/, "") : "";
    const position = rawPos === "DST" ? "DEF" : rawPos === "PK" ? "K" : SKILL.has(rawPos) ? rawPos : null;
    players.push({ name, position, team: teamIdx >= 0 ? f[teamIdx] || null : null, stats });
  }
  return { players, mapped: [...new Set(statIdx.map((s) => s.key))], unmapped };
}

/** score an uploaded projection CSV under league rules → ranked entries */
export function projectionCsvEntries(csv: ProjectionCsv, scoring: Record<string, number>): GuideEntry[] {
  return csv.players
    .map((p) => ({ ...p, points: scoreStatLine(p.stats, scoring) }))
    .filter((p) => p.points > 0)
    .sort((a, b) => b.points - a.points)
    .map((p, i) => ({ name: p.name, rank: i + 1, tier: null, position: p.position }));
}

/** season projection PPG for the value model: total points / games (17 when the row has no gp) */
export function projectionPpg(stats: StatLine | undefined, scoring: Record<string, number>): number {
  if (!stats) return 0;
  const games = stats.gp && stats.gp > 0 ? stats.gp : 17;
  return Math.round((scoreStatLine(stats, scoring) / games) * 100) / 100;
}
