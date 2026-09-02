// NFFC (high-stakes) ADP. Sharp drafters; PPR-ish. The public page renders an
// empty table and fills it client-side from a POST to /adp.data.php, so we hit
// that endpoint directly; it returns <tr> rows only (no header). Columns:
// Rk, Player, Team, Pos, ADP, Min, Max, Diff, #Picks, Team, Pick/Bid.
import { fetchText, loadIdMap, resolveSleeperId, toEntries, today } from "./lib.mjs";

const strip = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

export async function scrapeNffc(season, idMap) {
  const params = new URLSearchParams({
    team_id: "0",
    time_period: "",
    from_date: "",
    to_date: "",
    num_teams: "0", // all league sizes
    draft_type: "-1", // all drafts (non-superflex)
    sport: "football",
    position: "",
    league_teams: "0",
    as_board: "",
  });
  const html = await fetchText("https://nfc.shgn.com/adp.data.php", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", referer: "https://nfc.shgn.com/adp/football" },
    body: params.toString(),
  });
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => strip(c[1])))
    .filter((cells) => cells.length >= 5);
  const players = rows.map((c) => {
    const name = c[1];
    const position = c[3].replace(/\d+$/, "").toUpperCase() || null;
    return { name, position, adp: parseFloat(c[4]), sleeperId: resolveSleeperId(idMap, { name, position }) };
  });
  return { name: `NFFC ADP (${season}) — snapshot`, format: "ppr", scrapedAt: today(), entries: toEntries("NFFC", players) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const idMap = await loadIdMap();
  console.log(JSON.stringify(await scrapeNffc(process.argv[2] ?? new Date().getFullYear(), idMap)).slice(0, 400));
}
