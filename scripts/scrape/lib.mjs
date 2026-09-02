// Shared helpers for the ADP scrapers: DynastyProcess id map (GitHub-hosted,
// public), name normalisation, and the bundled-TS writer. Node 22+, no deps.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ID_MAP_URL = "https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv";
const ID_MAP_CACHE = resolve(ROOT, "scripts/scrape/.cache/db_playerids.csv");

export const normalizeName = (name) =>
  name
    .toLowerCase()
    .replace(/[.'’,-]/g, "")
    .replace(/\s+(jr|sr|ii|iii|iv|v)$/i, "")
    .replace(/\s+/g, " ")
    .trim();

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === "," && !quoted) {
      row.push(cur);
      cur = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else cur += c;
  }
  if (cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }
  const header = rows.shift().map((h) => h.trim());
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

export async function fetchText(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { "user-agent": "slept-on-scraper/1.0 (+https://github.com/glabadie2001/slept-on)", ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

/** id map: { bySleeper, byEspn, byYahoo, byFantasyPros, byMfl, byName } → sleeper id */
export async function loadIdMap() {
  let csv;
  if (existsSync(ID_MAP_CACHE)) csv = readFileSync(ID_MAP_CACHE, "utf8");
  else {
    csv = await fetchText(ID_MAP_URL);
    mkdirSync(dirname(ID_MAP_CACHE), { recursive: true });
    writeFileSync(ID_MAP_CACHE, csv);
  }
  const rows = parseCsv(csv).filter((r) => r.sleeper_id && r.sleeper_id !== "NA");
  const index = (col) => new Map(rows.filter((r) => r[col] && r[col] !== "NA").map((r) => [r[col], r]));
  const byName = new Map();
  for (const r of rows) {
    const key = `${normalizeName(r.name)}|${(r.position || "").toUpperCase()}`;
    if (!byName.has(key)) byName.set(key, r);
  }
  return { rows, byEspn: index("espn_id"), byYahoo: index("yahoo_id"), byFantasyPros: index("fantasypros_id"), byMfl: index("mfl_id"), byGsis: index("gsis_id"), byName };
}

/** resolve to a Sleeper id: exact id column first, then name+position, else null */
export function resolveSleeperId(idMap, { espnId, yahooId, fantasyProsId, mflId, gsisId, name, position }) {
  const hit =
    (espnId && idMap.byEspn.get(String(espnId))) ||
    (yahooId && idMap.byYahoo.get(String(yahooId))) ||
    (fantasyProsId && idMap.byFantasyPros.get(String(fantasyProsId))) ||
    (mflId && idMap.byMfl.get(String(mflId))) ||
    (gsisId && idMap.byGsis.get(String(gsisId))) ||
    (name && idMap.byName.get(`${normalizeName(name)}|${(position || "").toUpperCase()}`));
  return hit ? hit.sleeper_id : null;
}

/**
 * Turn [{name, position, adp, sleeperId}] into ranked GuideEntry[] and refuse
 * to emit a board that is suspiciously small — a silent empty board is worse
 * than a loud failure when a site changes its layout.
 */
export function toEntries(source, players, { minRows = 100 } = {}) {
  const good = players.filter((p) => p.name && Number.isFinite(p.adp) && p.adp > 0);
  if (good.length < minRows) {
    throw new Error(`${source}: only ${good.length} usable rows (need ≥ ${minRows}) — layout change?`);
  }
  good.sort((a, b) => a.adp - b.adp);
  const unmatched = good.filter((p) => !p.sleeperId).map((p) => p.name);
  if (unmatched.length) console.warn(`${source}: ${unmatched.length} names without a Sleeper id (name-matched at load time): ${unmatched.slice(0, 8).join(", ")}${unmatched.length > 8 ? "…" : ""}`);
  return good.map((p, i) => ({ name: p.name, rank: i + 1, tier: null, position: p.position ?? null, sleeperId: p.sleeperId ?? null }));
}

/** write src/data/bundledAdp.ts from a list of {name, format, scrapedAt, entries} */
export function writeBundledAdp(boards) {
  const out = resolve(ROOT, "src/data/bundledAdp.ts");
  const header = readFileSync(out, "utf8").split("export const BUNDLED_ADP")[0];
  const body = boards
    .map(
      (b) =>
        `  {\n    name: ${JSON.stringify(b.name)},\n    format: ${JSON.stringify(b.format)},\n    scrapedAt: ${JSON.stringify(b.scrapedAt)},\n    entries: [\n${b.entries
          .map((e) => `      { name: ${JSON.stringify(e.name)}, rank: ${e.rank}, tier: null, position: ${JSON.stringify(e.position)}, sleeperId: ${JSON.stringify(e.sleeperId)} },`)
          .join("\n")}\n    ],\n  },`,
    )
    .join("\n");
  writeFileSync(out, `${header}export const BUNDLED_ADP: BundledAdp[] = [\n${body}\n];\n`);
  console.log(`wrote ${boards.length} boards, ${boards.reduce((s, b) => s + b.entries.length, 0)} entries → ${out}`);
}

export const today = () => new Date().toISOString().slice(0, 10);
