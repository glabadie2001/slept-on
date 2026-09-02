// NFFC (high-stakes) ADP from the public HTML table. Sharp drafters; PPR-ish.
import { fetchText, loadIdMap, resolveSleeperId, toEntries, today } from "./lib.mjs";

const strip = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

export async function scrapeNffc(season, idMap) {
  const url = `https://nfc.shgn.com/adp/football`;
  const html = await fetchText(url);
  const table = /<table[^>]*>([\s\S]*?)<\/table>/i.exec(html);
  if (!table) throw new Error("NFFC: no <table> found — layout change?");
  const rows = [...table[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((m) => [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => strip(c[1])))
    .filter((cells) => cells.length >= 4);
  const header = rows.shift().map((h) => h.toLowerCase());
  const col = (...names) => header.findIndex((h) => names.some((n) => h.includes(n)));
  const iName = col("player");
  const iPos = col("pos");
  const iAdp = col("adp", "avg");
  if (iName < 0 || iAdp < 0) throw new Error(`NFFC: header ${JSON.stringify(header)} lacks player/adp columns`);
  const players = rows.map((c) => {
    const name = c[iName].replace(/\s+\([A-Z]{2,3}\)$/, "");
    const position = iPos >= 0 ? c[iPos].replace(/\d+$/, "").toUpperCase() : null;
    return { name, position, adp: parseFloat(c[iAdp]), sleeperId: resolveSleeperId(idMap, { name, position }) };
  });
  return { name: `NFFC ADP (${season}) — snapshot`, format: "ppr", scrapedAt: today(), entries: toEntries("NFFC", players) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const idMap = await loadIdMap();
  console.log(JSON.stringify(await scrapeNffc(process.argv[2] ?? new Date().getFullYear(), idMap)).slice(0, 400));
}
