// ESPN ADP via the public fantasy API used by ESPN's own draft lobby.
// Returns one board per scoring format we can request (ESPN reports one
// blended ADP per player; format is a label, not a filter).
import { loadIdMap, resolveSleeperId, toEntries, today } from "./lib.mjs";

const POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DEF" };

export async function scrapeEspn(season, idMap) {
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leaguedefaults/3?view=kona_player_info`;
  const filter = { players: { filterSlotIds: { value: [0, 2, 4, 6, 17, 16] }, limit: 400, sortAdp: { sortPriority: 1, sortAsc: true }, filterStatsForTopScoringPeriodIds: { value: 2 } } };
  const res = await fetch(url, { headers: { "x-fantasy-filter": JSON.stringify(filter), "x-fantasy-platform": "kona", accept: "application/json" } });
  if (!res.ok) throw new Error(`ESPN → HTTP ${res.status}`);
  const json = await res.json();
  const rows = (json.players ?? []).map((p) => {
    const pl = p.player ?? {};
    const adp = pl.ownership?.averageDraftPosition;
    return {
      name: pl.fullName,
      position: POS[pl.defaultPositionId] ?? null,
      adp: typeof adp === "number" ? adp : NaN,
      sleeperId: resolveSleeperId(idMap, { espnId: pl.id, name: pl.fullName, position: POS[pl.defaultPositionId] }),
    };
  });
  return { name: `ESPN ADP (${season}) — snapshot`, format: "ppr", scrapedAt: today(), entries: toEntries("ESPN", rows) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const idMap = await loadIdMap();
  console.log(JSON.stringify(await scrapeEspn(process.argv[2] ?? new Date().getFullYear(), idMap)).slice(0, 400));
}
