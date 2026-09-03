// NFL bye weeks by Sleeper team code for the 2026 season, taken from the
// team/bye column of PFF's 2026 draft cheat sheet (src/data/PFF Fantasy 2026.pdf).
export const BYE_SEASON = "2026";

export const BYE_WEEKS: Record<string, number> = {
  ARI: 14,
  ATL: 11,
  BAL: 13,
  BUF: 7,
  CAR: 5,
  CHI: 10,
  CIN: 6,
  CLE: 11,
  DAL: 14,
  DEN: 10,
  DET: 6,
  GB: 11,
  HOU: 8,
  IND: 13,
  JAX: 7,
  KC: 5,
  LAC: 7,
  LAR: 11,
  LV: 13,
  MIA: 6,
  MIN: 6,
  NE: 11,
  NO: 8,
  NYG: 8,
  NYJ: 13,
  PHI: 10,
  PIT: 9,
  SEA: 11,
  SF: 8,
  TB: 10,
  TEN: 9,
  WAS: 7,
};

/** bye week for a Sleeper team code, or null when unknown / free agent */
export const byeWeekOf = (team: string | null | undefined): number | null =>
  team ? (BYE_WEEKS[team] ?? null) : null;
