// npm run scrape [season] — run every ADP scraper, keep the ones that succeed,
// and rewrite src/data/bundledAdp.ts. A scraper that fails (layout change,
// blocked, missing input file) is reported and skipped; if *none* succeed the
// bundled file is left untouched and the process exits non-zero.
import { loadIdMap, writeBundledAdp } from "./lib.mjs";
import { scrapeEspn } from "./espn.mjs";
import { scrapeNffc } from "./nffc.mjs";
import { scrapeUnderdog } from "./underdog.mjs";

const season = process.argv[2] ?? String(new Date().getFullYear());
const idMap = await loadIdMap();
console.log(`id map: ${idMap.rows.length} players with Sleeper ids`);

const scrapers = [
  ["ESPN", scrapeEspn],
  ["NFFC", scrapeNffc],
  ["Underdog", scrapeUnderdog],
];
const boards = [];
const failures = [];
for (const [name, fn] of scrapers) {
  try {
    const board = await fn(season, idMap);
    console.log(`✓ ${name}: ${board.entries.length} players`);
    boards.push(board);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.error(`✗ ${name}: ${err.message}`);
  }
}
if (boards.length === 0) {
  console.error("no scraper succeeded — bundledAdp.ts left untouched");
  process.exit(1);
}
writeBundledAdp(boards);
if (failures.length) console.error(`\n${failures.length} scraper(s) failed:\n  ${failures.join("\n  ")}`);
