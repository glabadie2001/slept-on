// Underdog Fantasy has no public ADP endpoint; it exports a rankings CSV from the
// app (firstName,lastName,adp,projectedPoints,positionRank,slotName,teamName…).
// Drop the export at scripts/scrape/input/underdog.csv and this turns it into a
// bundled board. (The same CSV also uploads straight into the Draft tab.)
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, loadIdMap, parseCsv, resolveSleeperId, toEntries, today } from "./lib.mjs";

export async function scrapeUnderdog(season, idMap) {
  const file = resolve(ROOT, "scripts/scrape/input/underdog.csv");
  if (!existsSync(file)) throw new Error(`Underdog: put the app's rankings CSV export at ${file}`);
  const rows = parseCsv(readFileSync(file, "utf8"));
  const players = rows.map((r) => {
    const name = r.name ?? `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim();
    const position = (r.slotName ?? r.position ?? "").toUpperCase().replace(/\d+$/, "") || null;
    return { name, position, adp: parseFloat(r.adp), sleeperId: resolveSleeperId(idMap, { name, position }) };
  });
  return { name: `Underdog ADP (${season}) — snapshot`, format: "half_ppr", scrapedAt: today(), entries: toEntries("Underdog", players) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const idMap = await loadIdMap();
  console.log(JSON.stringify(await scrapeUnderdog(process.argv[2] ?? new Date().getFullYear(), idMap)).slice(0, 400));
}
