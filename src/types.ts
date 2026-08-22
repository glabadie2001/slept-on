// ---- Sleeper API entities (documented v1 endpoints) ----

export interface SleeperState {
  week: number;
  season: string; // e.g. "2026"
  season_type: "pre" | "regular" | "post" | "off";
  display_week: number;
  league_season: string;
  previous_season: string;
}

export interface SleeperUser {
  user_id: string;
  username?: string;
  display_name: string;
  avatar: string | null;
  metadata?: { team_name?: string; avatar?: string } | null;
  is_owner?: boolean;
}

export interface SleeperLeague {
  league_id: string;
  name: string;
  season: string;
  status: "pre_draft" | "drafting" | "in_season" | "complete";
  sport: "nfl";
  total_rosters: number;
  roster_positions: string[]; // e.g. ["QB","RB","RB","WR","WR","TE","FLEX","SUPER_FLEX","BN",...]
  scoring_settings: Record<string, number>;
  settings: {
    leg?: number; // current week within the league
    playoff_week_start?: number;
    num_teams?: number;
    waiver_budget?: number;
    waiver_type?: number; // 2 = FAAB
    trade_deadline?: number;
    type?: number; // 0 redraft, 1 keeper, 2 dynasty
    taxi_slots?: number;
    reserve_slots?: number;
    [k: string]: number | undefined;
  };
  previous_league_id: string | null;
  draft_id?: string | null;
  avatar: string | null;
}

export interface SleeperRoster {
  roster_id: number;
  owner_id: string | null;
  co_owners?: string[] | null;
  league_id: string;
  players: string[] | null;
  starters: string[] | null;
  reserve?: string[] | null; // IR slots
  taxi?: string[] | null;
  settings: {
    wins: number;
    losses: number;
    ties: number;
    fpts: number;
    fpts_decimal?: number;
    fpts_against?: number;
    fpts_against_decimal?: number;
    waiver_budget_used?: number;
    waiver_position?: number;
    [k: string]: number | undefined;
  };
}

export interface SleeperMatchup {
  roster_id: number;
  matchup_id: number | null;
  points: number;
  players: string[] | null;
  starters: string[] | null;
  starters_points?: number[] | null;
  players_points?: Record<string, number> | null;
}

export interface SleeperPlayer {
  player_id: string;
  first_name?: string;
  last_name?: string;
  full_name?: string; // absent for team defenses
  position?: string | null;
  fantasy_positions?: string[] | null;
  team?: string | null; // e.g. "LAR", null = free agent
  age?: number | null;
  years_exp?: number | null;
  status?: string | null; // "Active", "Inactive", "Injured Reserve", ...
  injury_status?: string | null; // "Questionable" | "Doubtful" | "Out" | "IR" | "PUP" | "Sus" | "COV" | "NA"
  injury_body_part?: string | null;
  injury_notes?: string | null;
  practice_participation?: string | null;
  depth_chart_order?: number | null;
  depth_chart_position?: string | null;
  number?: number | null;
  height?: string | null;
  weight?: string | null;
  college?: string | null;
  search_rank?: number | null; // Sleeper's overall search rank (lower = better); 9999999 = irrelevant
}

export type PlayerMap = Record<string, SleeperPlayer>;

export interface SleeperTransaction {
  transaction_id: string;
  type: "trade" | "free_agent" | "waiver" | "commissioner";
  status: "complete" | "failed" | "processing";
  roster_ids: number[];
  adds: Record<string, number> | null; // player_id -> roster_id
  drops: Record<string, number> | null;
  draft_picks: {
    season: string;
    round: number;
    roster_id: number; // original owner of the pick's slot
    previous_owner_id: number;
    owner_id: number; // receiving roster
  }[];
  waiver_budget: { sender: number; receiver: number; amount: number }[];
  status_updated: number; // epoch ms
  creator?: string;
  leg?: number;
}

export interface SleeperTradedPick {
  season: string;
  round: number;
  roster_id: number; // original slot owner
  previous_owner_id: number;
  owner_id: number; // current owner
}

export interface TrendingPlayer {
  player_id: string;
  count: number;
}

// ---- Projections / stats (api.sleeper.com, semi-official) ----

// Raw stat lines keyed by Sleeper stat names (pass_yd, rush_td, rec, ...).
// League scoring_settings uses the same keys, so custom scoring is a dot product.
export type StatLine = Record<string, number>;

export interface ProjectionRow {
  player_id: string;
  stats: StatLine;
  week?: number | null;
  season?: string;
  player?: { position?: string } | null;
}

// ---- App-level derived types ----

export interface TeamInfo {
  rosterId: number;
  ownerId: string | null;
  teamName: string;
  ownerName: string;
  avatar: string | null;
  roster: SleeperRoster;
  isMine: boolean;
}

export interface LeagueBundle {
  state: SleeperState;
  league: SleeperLeague;
  users: SleeperUser[];
  rosters: SleeperRoster[];
  players: PlayerMap;
  myUserId: string;
  /** week-level projections for the active/upcoming week, custom-scored */
  projections: Record<string, StatLine>;
  /** last completed season's per-player season stat totals (fallback + baselines) */
  lastSeasonStats: Record<string, StatLine>;
  lastSeasonYear: string;
  matchups: SleeperMatchup[];
  /** every regular-season week's matchups (past weeks carry actual points,
   *  future weeks carry the schedule) — feeds the playoff simulator */
  schedule: Record<number, SleeperMatchup[]>;
  transactions: SleeperTransaction[];
  tradedPicks: SleeperTradedPick[];
  trendingAdds: TrendingPlayer[];
  trendingDrops: TrendingPlayer[];
  /** which week matchups/projections refer to */
  week: number;
  isOffseason: boolean;
  demo: boolean;
}
