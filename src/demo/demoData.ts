import type {
  LeagueBundle,
  PlayerMap,
  SleeperLeague,
  SleeperMatchup,
  SleeperRoster,
  SleeperTradedPick,
  SleeperTransaction,
  SleeperUser,
  StatLine,
} from "../types";

// A deterministic 12-team superflex dynasty league so the whole dashboard can be
// exercised (and screenshot-tested) without touching the network. Seeded PRNG —
// same league every load.

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["Jalen", "Marcus", "Tyrone", "Devin", "Chris", "Xavier", "Trent", "Malik", "Jordan", "Caleb", "Drake", "Zion", "Amari", "Rashee", "Tank", "Bijan", "Breece", "Nico", "Garrett", "Romeo", "Keon", "Jaxon", "DeVon", "Trey", "Kyren", "Jahmyr", "Ladd", "Rome", "Brock", "Sam", "Michael", "Isaiah"];
const LAST = ["Williams", "Johnson", "Carter", "Robinson", "Harris", "Brooks", "Mitchell", "Coleman", "Bennett", "Hayes", "Walker", "Reed", "Jenkins", "Porter", "Dell", "Rice", "Nabers", "Odunze", "Bowers", "Irving", "Wright", "Pearsall", "Legette", "Corley", "Franklin", "Shaheed", "Dotson", "Hyatt", "Palmer", "Sinnott", "McBride", "Ferguson"];
const TEAMS = ["ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC", "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS"];
const TEAM_NAMES = ["The Rebuild", "Dynasty Destroyers", "Mixon It Up", "Waiver Wire Warriors", "Championship or Bust", "The Process", "Gridiron Geeks", "End Zone Elite", "Trust the Tank", "Playoff Push", "The Contenders", "Draft Capital"];
const INJURIES: [string, string][] = [["Questionable", "Hamstring"], ["Questionable", "Ankle"], ["Doubtful", "Knee"], ["Out", "Concussion"], ["IR", "ACL"]];

interface DemoPlayer {
  id: string;
  pos: string;
  ppg: number;
  age: number;
}

export function buildDemoBundle(): LeagueBundle {
  const rand = mulberry32(20260717);
  const players: PlayerMap = {};
  const pool: DemoPlayer[] = [];
  let nextId = 1000;
  const usedNames = new Set<string>();

  const addPlayer = (pos: string, tier: number, opts: { name?: string; age?: number } = {}): DemoPlayer => {
    const id = String(nextId++);
    let name = opts.name;
    if (!name) {
      do {
        name = `${FIRST[Math.floor(rand() * FIRST.length)]} ${LAST[Math.floor(rand() * LAST.length)]}`;
      } while (usedNames.has(name));
    }
    usedNames.add(name);
    const age = opts.age ?? Math.floor(22 + rand() * (pos === "QB" ? 14 : 10));
    // tier 1 = elite ... 5 = waiver fodder
    const base: Record<string, number> = { QB: 22, RB: 16, WR: 16, TE: 12, K: 8, DEF: 7 };
    const ppg = Math.max(1, (base[pos] ?? 10) * (1.15 - tier * 0.18) + (rand() - 0.5) * 3);
    const [first, ...rest] = name.split(" ");
    const injured = rand() < 0.12 ? INJURIES[Math.floor(rand() * INJURIES.length)] : null;
    players[id] = {
      player_id: id,
      first_name: first,
      last_name: rest.join(" "),
      full_name: name,
      position: pos,
      fantasy_positions: [pos],
      team: TEAMS[Math.floor(rand() * TEAMS.length)],
      age,
      years_exp: Math.max(0, age - 22),
      status: "Active",
      injury_status: injured?.[0] ?? null,
      injury_body_part: injured?.[1] ?? null,
      search_rank: tier * 60 + Math.floor(rand() * 50),
    };
    const p = { id, pos, ppg, age };
    pool.push(p);
    return p;
  };

  // Named stars for flavor (the backstory demands them).
  const puka = addPlayer("WR", 1, { name: "Puka Nacua", age: 25 });
  const mixon = addPlayer("RB", 3, { name: "Joe Mixon", age: 30 });

  // League-wide talent pool.
  for (let tier = 1; tier <= 5; tier++) {
    const perTier = { QB: [4, 6, 8, 8, 10], RB: [6, 8, 12, 14, 16], WR: [8, 10, 14, 16, 18], TE: [3, 4, 6, 8, 10], K: [2, 3, 4, 6, 8], DEF: [2, 3, 4, 6, 8] };
    for (const [pos, counts] of Object.entries(perTier)) {
      for (let i = 0; i < counts[tier - 1]; i++) addPlayer(pos, tier);
    }
  }

  // Draft 12 rosters snake-style by ppg (with noise), then hand-tune the story:
  // roster 1 = "my" struggling team (has Mixon), roster 7 = juggernaut (has Puka).
  const drafted = pool
    .filter((p) => p !== puka && p !== mixon)
    .sort((a, b) => b.ppg + rand() * 4 - (a.ppg + rand() * 4));
  const rosterPlayers: string[][] = Array.from({ length: 12 }, () => []);
  const need = { QB: 3, RB: 5, WR: 6, TE: 2, K: 1, DEF: 1 };
  const counts: Record<number, Record<string, number>> = {};
  let dir = 1;
  let idx = 0;
  for (const p of drafted) {
    let placed = false;
    for (let tries = 0; tries < 12 && !placed; tries++) {
      const c = (counts[idx] ??= {});
      if ((c[p.pos] ?? 0) < (need[p.pos as keyof typeof need] ?? 0) && rosterPlayers[idx].length < 18) {
        rosterPlayers[idx].push(p.id);
        c[p.pos] = (c[p.pos] ?? 0) + 1;
        placed = true;
      }
      idx += dir;
      if (idx === 12) { idx = 11; dir = -1; }
      if (idx === -1) { idx = 0; dir = 1; }
    }
  }
  // Story adjustments: juggernaut (roster 7) gets Puka; my team (roster 1) got Mixon.
  rosterPlayers[6].unshift(puka.id);
  rosterPlayers[0].push(mixon.id);
  // Handicap my team: my best skill player goes to the juggernaut's bench
  // (the previous regime's parting gift)... dire times.
  const mine = rosterPlayers[0];
  mine.sort((a, b) => (pool.find((p) => p.id === b)?.ppg ?? 0) - (pool.find((p) => p.id === a)?.ppg ?? 0));
  rosterPlayers[6].push(...mine.splice(0, 1));

  // ---- Incoming rookie class (next year's rookie draft): unrostered, no NFL
  // team yet (so waivers ignore them), no stats — value comes from draft-capital
  // proxy (search_rank) alone. The Draft tab's sample guides rank this class.
  const ROOKIE_POSITIONS = ["RB", "WR", "WR", "RB", "QB", "WR", "TE", "RB", "WR", "QB", "WR", "TE"];
  for (let i = 0; i < 52; i++) {
    const pos = ROOKIE_POSITIONS[i % ROOKIE_POSITIONS.length];
    const id = String(nextId++);
    let name: string;
    do {
      name = `${FIRST[Math.floor(rand() * FIRST.length)]} ${LAST[Math.floor(rand() * LAST.length)]}`;
    } while (usedNames.has(name));
    usedNames.add(name);
    const [first, ...rest] = name.split(" ");
    players[id] = {
      player_id: id,
      first_name: first,
      last_name: rest.join(" "),
      full_name: name,
      position: pos,
      fantasy_positions: [pos],
      team: null,
      age: 21 + Math.floor(rand() * 3),
      years_exp: 0,
      status: "Active",
      injury_status: null,
      injury_body_part: null,
      // class rank → market interest; top of the class rivals mid-tier vets
      search_rank: 70 + i * 6 + Math.floor(rand() * 12),
    };
  }

  const scoring: Record<string, number> = {
    pass_yd: 0.04, pass_td: 4, pass_int: -1, rush_yd: 0.1, rush_td: 6,
    rec: 0.5, rec_yd: 0.1, rec_td: 6, bonus_rec_te: 0.5, fum_lost: -2,
    fgm: 3, xpm: 1, def_td: 6, sack: 1, int: 2, pts_allow_0: 10,
  };

  // Convert a target PPG into a plausible raw stat line for that position.
  const statsForPpg = (pos: string, ppg: number): StatLine => {
    switch (pos) {
      case "QB": {
        const passYd = ppg * 12;
        return { pass_yd: passYd, pass_td: ppg * 0.09, pass_int: 0.6, rush_yd: ppg * 0.9, gp: 16 };
      }
      case "RB":
        return { rush_yd: ppg * 5.2, rush_td: ppg * 0.028, rec: ppg * 0.16, rec_yd: ppg * 1.4, gp: 15 };
      case "WR":
        return { rec: ppg * 0.32, rec_yd: ppg * 4.6, rec_td: ppg * 0.022, gp: 16 };
      case "TE":
        return { rec: ppg * 0.34, rec_yd: ppg * 4.2, rec_td: ppg * 0.025, gp: 16 };
      case "K":
        return { fgm: ppg * 0.25, xpm: ppg * 0.25, gp: 17 };
      default:
        return { sack: ppg * 0.35, int: ppg * 0.15, def_td: 0.1, gp: 17 };
    }
  };

  const lastSeasonStats: Record<string, StatLine> = {};
  const projections: Record<string, StatLine> = {};
  for (const p of pool) {
    const season = statsForPpg(p.pos, p.ppg);
    const games = season.gp!;
    lastSeasonStats[p.id] = Object.fromEntries(
      Object.entries(season).map(([k, v]) => [k, k === "gp" ? v : v * games]),
    );
    const weekVariance = 0.75 + rand() * 0.5;
    projections[p.id] = Object.fromEntries(
      Object.entries(season)
        .filter(([k]) => k !== "gp")
        .map(([k, v]) => [k, v * weekVariance]),
    );
  }

  const league: SleeperLeague = {
    league_id: "demo",
    name: "Against All Odds (Demo)",
    season: "2026",
    status: "in_season",
    sport: "nfl",
    total_rosters: 12,
    roster_positions: ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "SUPER_FLEX", "K", "DEF", "BN", "BN", "BN", "BN", "BN", "BN", "IR", "IR"],
    scoring_settings: scoring,
    settings: { leg: 6, playoff_week_start: 15, num_teams: 12, waiver_budget: 100, waiver_type: 2, type: 2, taxi_slots: 3, reserve_slots: 2 },
    previous_league_id: null,
    avatar: null,
  };

  const users: SleeperUser[] = Array.from({ length: 12 }, (_, i) => ({
    user_id: `u${i + 1}`,
    display_name: i === 0 ? "glabadie2001" : `manager_${i + 1}`,
    avatar: null,
    metadata: { team_name: TEAM_NAMES[i] },
  }));

  const rosters: SleeperRoster[] = rosterPlayers.map((ids, i) => ({
    roster_id: i + 1,
    owner_id: `u${i + 1}`,
    league_id: "demo",
    players: ids,
    starters: [],
    reserve: [],
    settings: { wins: 0, losses: 0, ties: 0, fpts: 0, fpts_against: 0, waiver_position: 12 - i, waiver_budget_used: Math.floor(rand() * 60) },
  }));

  // Set starters = optimal-ish by ppg per slot need (leave my team with one
  // injured starter so lineup advice has something to say).
  for (const r of rosters) {
    const ids = [...(r.players ?? [])];
    const byPos = (pos: string) =>
      ids
        .filter((id) => players[id]?.position === pos)
        .sort((a, b) => (projections[b]?.rec_yd ?? 0) + (projections[b]?.rush_yd ?? 0) + (projections[b]?.pass_yd ?? 0) - ((projections[a]?.rec_yd ?? 0) + (projections[a]?.rush_yd ?? 0) + (projections[a]?.pass_yd ?? 0)));
    const taken = new Set<string>();
    const take = (pos: string[]): string => {
      for (const p of pos) {
        const c = byPos(p).find((id) => !taken.has(id));
        if (c) { taken.add(c); return c; }
      }
      return "0";
    };
    r.starters = [
      take(["QB"]), take(["RB"]), take(["RB"]), take(["WR"]), take(["WR"]), take(["WR"]),
      take(["TE"]), take(["RB", "WR", "TE"]), take(["QB", "RB", "WR", "TE"]), take(["K"]), take(["DEF"]),
    ];
  }

  // ---- Roster-management storylines for my team (roster 1): a bench player
  // stuck on the active roster with a season-ending injury while both IR slots
  // sit open, plus a rookie class split between the taxi squad and the active
  // roster — so IR hygiene, taxi stash/promote, and drop advice all light up.
  {
    const myR = rosters[0];
    const starterSet = new Set((myR.starters ?? []).filter((s) => s !== "0"));
    const benchIds = (myR.players ?? []).filter((id) => !starterSet.has(id));
    const irGuy = benchIds.find((id) => players[id]?.position === "WR") ?? benchIds[0];
    if (irGuy) {
      players[irGuy].injury_status = "IR";
      players[irGuy].injury_body_part = "ACL";
    }
    const rookies = benchIds.filter((id) => id !== irGuy && players[id]?.position !== "K" && players[id]?.position !== "DEF").slice(-2);
    for (const id of rookies) {
      players[id].age = 22;
      players[id].years_exp = 0;
      players[id].injury_status = null;
    }
    if (rookies[0]) myR.taxi = [rookies[0]]; // second rookie stays active → stash advice fires
  }

  // ---- Full 14-week regular season: circle-method round robin, weeks 1-5
  // played out with strength-biased scores (so records/points are consistent
  // and the playoff simulator has real weekly data), week 6 = current. ----
  const REG_SEASON_END = 14;
  const CURRENT_WEEK = 6;

  // Team strength = sum of starters' true ppg, with story handicaps.
  const ppgOf = new Map(pool.map((p) => [p.id, p.ppg]));
  const teamMean = rosters.map((r) => {
    const starters = (r.starters ?? []).filter((s) => s !== "0");
    const base = starters.reduce((s, id) => s + (ppgOf.get(id) ?? 0), 0);
    return base + (r.roster_id === 1 ? -4 : r.roster_id === 7 ? 7 : 0);
  });

  // Circle-method pairings with roster 7 (the juggernaut) in the fixed seat.
  const circle = [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12];
  const weekPairs = (week: number): [number, number][] => {
    const rot = circle.map((_, i) => circle[(i + week - 1) % circle.length]);
    const out: [number, number][] = [[7, rot[0]]];
    for (let i = 1; i <= 5; i++) out.push([rot[i], rot[circle.length - i]]);
    return out;
  };
  const gauss = () => (rand() + rand() + rand() + rand() - 2) * 1.55; // ~N(0,0.9)

  const schedule: Record<number, SleeperMatchup[]> = {};
  for (let week = 1; week <= REG_SEASON_END; week++) {
    const played = week < CURRENT_WEEK;
    schedule[week] = weekPairs(week).flatMap(([a, b], m) =>
      [a, b].map((rid) => {
        const r = rosters[rid - 1];
        const points = played
          ? Math.round(Math.max(40, teamMean[rid - 1] + gauss() * 20) * 100) / 100
          : 0;
        return {
          roster_id: rid,
          matchup_id: m + 1,
          points,
          players: r.players,
          starters: r.starters,
        };
      }),
    );
  }

  // Records + points from the played weeks.
  for (let week = 1; week < CURRENT_WEEK; week++) {
    const byId = new Map<number, SleeperMatchup[]>();
    for (const m of schedule[week]) {
      const arr = byId.get(m.matchup_id!) ?? [];
      arr.push(m);
      byId.set(m.matchup_id!, arr);
    }
    for (const [a, b] of [...byId.values()] as [SleeperMatchup, SleeperMatchup][]) {
      const ra = rosters[a.roster_id - 1].settings;
      const rb = rosters[b.roster_id - 1].settings;
      ra.fpts = Math.round((ra.fpts + a.points) * 100) / 100;
      rb.fpts = Math.round((rb.fpts + b.points) * 100) / 100;
      ra.fpts_against = Math.round(((ra.fpts_against ?? 0) + b.points) * 100) / 100;
      rb.fpts_against = Math.round(((rb.fpts_against ?? 0) + a.points) * 100) / 100;
      if (a.points > b.points) {
        ra.wins++;
        rb.losses++;
      } else {
        rb.wins++;
        ra.losses++;
      }
    }
  }

  const matchups: SleeperMatchup[] = schedule[CURRENT_WEEK];

  // The infamous trade, on the ledger.
  const transactions: SleeperTransaction[] = [
    {
      transaction_id: "t1",
      type: "trade",
      status: "complete",
      roster_ids: [1, 7],
      adds: { [mixon.id]: 1, [puka.id]: 7 },
      drops: { [puka.id]: 1, [mixon.id]: 7 },
      draft_picks: [],
      waiver_budget: [],
      status_updated: 1746000000000,
    },
  ];

  const tradedPicks: SleeperTradedPick[] = [
    { season: "2027", round: 1, roster_id: 1, previous_owner_id: 1, owner_id: 7 },
    { season: "2027", round: 2, roster_id: 4, previous_owner_id: 4, owner_id: 1 },
    { season: "2028", round: 1, roster_id: 7, previous_owner_id: 7, owner_id: 1 },
  ];

  const freeAgents = pool.filter((p) => !rosterPlayers.some((r) => r.includes(p.id)));
  const trendingAdds = freeAgents
    .sort((a, b) => b.ppg - a.ppg)
    .slice(0, 25)
    .map((p, i) => ({ player_id: p.id, count: Math.floor(5000 / (i + 1)) }));

  return {
    state: { week: 6, season: "2026", season_type: "regular", display_week: 6, league_season: "2026", previous_season: "2025" },
    league,
    users,
    rosters,
    players,
    myUserId: "u1",
    projections,
    seasonProjections: {},
    lastSeasonStats,
    lastSeasonYear: "2025",
    matchups,
    schedule,
    transactions,
    tradedPicks,
    trendingAdds,
    trendingDrops: trendingAdds.slice(10).map((t) => ({ ...t })),
    week: 6,
    isOffseason: false,
    demo: true,
  };
}
