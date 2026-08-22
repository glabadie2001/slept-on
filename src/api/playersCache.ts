import { idbGet, idbSet } from "./idb";
import type { PlayerMap, SleeperPlayer } from "../types";

// The full players/nfl blob is ~5 MB / ~11k players. We trim it to fantasy-relevant
// entries and cache in IndexedDB with a TTL so it's fetched at most once a day.

const PLAYERS_KEY = "players_nfl";
const TTL_MS = 24 * 60 * 60 * 1000;

const RELEVANT_POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

interface CachedBlob {
  savedAt: number;
  players: PlayerMap;
}

export function trimPlayers(raw: Record<string, Partial<SleeperPlayer>>): PlayerMap {
  const out: PlayerMap = {};
  for (const [id, p] of Object.entries(raw)) {
    if (!p || !p.position || !RELEVANT_POSITIONS.has(p.position)) continue;
    out[id] = {
      player_id: id,
      first_name: p.first_name,
      last_name: p.last_name,
      full_name: p.full_name ?? (p.first_name ? `${p.first_name} ${p.last_name ?? ""}`.trim() : id),
      position: p.position,
      fantasy_positions: p.fantasy_positions,
      team: p.team ?? null,
      age: p.age ?? null,
      years_exp: p.years_exp ?? null,
      status: p.status ?? null,
      injury_status: p.injury_status ?? null,
      injury_body_part: p.injury_body_part ?? null,
      injury_notes: p.injury_notes ?? null,
      practice_participation: p.practice_participation ?? null,
      depth_chart_order: p.depth_chart_order ?? null,
      depth_chart_position: p.depth_chart_position ?? null,
      number: p.number ?? null,
      college: p.college ?? null,
      search_rank: p.search_rank ?? null,
    };
  }
  return out;
}

export async function loadPlayersWithCache(fetcher: () => Promise<PlayerMap>): Promise<PlayerMap> {
  const cached = await idbGet<CachedBlob>(PLAYERS_KEY);
  if (cached && Date.now() - cached.savedAt < TTL_MS && Object.keys(cached.players).length > 0) {
    return cached.players;
  }
  try {
    const players = await fetcher();
    await idbSet(PLAYERS_KEY, { savedAt: Date.now(), players } satisfies CachedBlob);
    return players;
  } catch (err) {
    // Network failed — a stale cache beats a dead dashboard.
    if (cached) return cached.players;
    throw err;
  }
}
