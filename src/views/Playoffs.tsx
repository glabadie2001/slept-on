import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useAppData } from "../AppContext";
import { MiniBar, StatTile } from "../components";
import { optimizeLineup } from "../lib/lineup";
import {
  buildSeasonSchedule,
  DEFAULT_SIMS,
  empiricalSd,
  simulateSeason,
} from "../lib/simulator";
import type { SimKnobs, SimTeamInput } from "../lib/simulator";

const SIM_CHOICES = [1000, 5000, 20000, 50000];

function Knob({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="knob">
      <div className="knob-label">
        {label}
        {hint && <span className="muted small"> · {hint}</span>}
      </div>
      {children}
    </div>
  );
}

export function Playoffs() {
  const { bundle, teams, myTeam, projPts } = useAppData();
  const myRosterId = myTeam?.rosterId ?? null;
  const byRoster = new Map(teams.map((t) => [t.rosterId, t]));

  const season = useMemo(() => buildSeasonSchedule(bundle), [bundle]);

  const simTeams = useMemo<SimTeamInput[]>(
    () =>
      bundle.rosters.map((r) => {
        const optimal = optimizeLineup(bundle.league, r.players ?? [], bundle.players, projPts);
        const s = r.settings;
        return {
          rosterId: r.roster_id,
          wins: s.wins,
          losses: s.losses,
          ties: s.ties,
          fpts: s.fpts + (s.fpts_decimal ?? 0) / 100,
          weeklyScores: season.weeklyScores[r.roster_id] ?? [],
          projPpg: optimal.totalProjected,
        };
      }),
    [bundle, projPts, season],
  );

  const gamesPlayed = season.completedWeeks.length;
  const defaultSd = useMemo(() => empiricalSd(simTeams), [simTeams]);

  // ---- knobs ----
  const [sims, setSims] = useState(DEFAULT_SIMS);
  const [blend, setBlend] = useState<number | null>(null); // null = auto
  const [halfLife, setHalfLife] = useState<number | null>(null); // null = flat
  const [volatility, setVolatility] = useState<number | null>(null); // null = auto
  const [playoffTeams, setPlayoffTeams] = useState<number | null>(null);
  const [medianWins, setMedianWins] = useState(false);
  const [forced, setForced] = useState<Record<string, "W" | "L">>({});
  const [boosts, setBoosts] = useState<Record<number, number>>({});
  const [seed, setSeed] = useState(1337);

  const autoBlend = gamesPlayed >= 3 ? 0.35 : 0.85;
  const leaguePlayoffTeams = bundle.league.settings.playoff_teams ?? 6;
  const knobs: SimKnobs = {
    sims,
    seed,
    blend: blend ?? autoBlend,
    recencyHalfLife: halfLife,
    volatility,
    playoffTeams: playoffTeams ?? leaguePlayoffTeams,
    medianWins,
    forced,
    boosts,
  };

  const result = useMemo(
    () => simulateSeason(simTeams, season.games, knobs, myRosterId),
    // eslint-style exhaustive deps spelled out so knob changes re-simulate
    [simTeams, season, sims, seed, blend, halfLife, volatility, playoffTeams, medianWins, forced, boosts, myRosterId, autoBlend], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const mine = result.teams.find((t) => t.rosterId === myRosterId);
  const sorted = [...result.teams].sort((a, b) => b.playoffPct - a.playoffPct || b.avgWins - a.avgWins);
  const myStrength = result.strengths.find((s) => s.rosterId === myRosterId);

  const forceKey = (week: number) => `${week}:${myRosterId}`;
  const cycleForce = (week: number, dir: "W" | "L") => {
    const key = forceKey(week);
    setForced((f) => {
      const next = { ...f };
      if (next[key] === dir) delete next[key];
      else next[key] = dir;
      return next;
    });
  };

  const setBoost = (rosterId: number, delta: number) =>
    setBoosts((b) => {
      const next = { ...b, [rosterId]: Math.round(((b[rosterId] ?? 0) + delta) * 10) / 10 };
      if (next[rosterId] === 0) delete next[rosterId];
      return next;
    });

  const anyWhatIf = Object.keys(forced).length > 0 || Object.keys(boosts).length > 0;

  if (season.games.length === 0) {
    return (
      <div className="card">
        <h2>Playoff odds</h2>
        <p className="muted">
          No remaining regular-season games to simulate — the regular season is over. Playoff odds
          become bracket odds; check back next season (or explore the demo league).
        </p>
      </div>
    );
  }

  return (
    <div>
      {season.synthetic && (
        <div className="demo-banner">
          🗓️ <strong>No schedule from Sleeper yet</strong> (preseason). Simulating a hypothetical
          round-robin schedule — odds reflect roster strength, not real pairings.
        </div>
      )}

      <div className="stat-row">
        <StatTile
          label="Your playoff odds"
          value={mine ? `${mine.playoffPct}%` : "—"}
          sub={mine && result.byes > 0 ? `${mine.byePct}% first-round bye` : `top ${knobs.playoffTeams} make it`}
        />
        <StatTile label="Title odds" value={mine ? `${mine.titlePct}%` : "—"} sub="win the whole bracket" />
        <StatTile
          label="Projected record"
          value={mine ? `${mine.avgWins.toFixed(1)} W` : "—"}
          sub={myTeam ? `currently ${myTeam.roster.settings.wins}-${myTeam.roster.settings.losses}` : ""}
        />
        <StatTile
          label="Avg finish"
          value={mine ? `#${mine.avgSeed.toFixed(1)}` : "—"}
          sub={`${result.sims.toLocaleString()} sims · σ ${result.sd}`}
        />
      </div>

      <div className="card section">
        <h2>Simulation controls {anyWhatIf && <span className="whatif-flag">what-if active</span>}</h2>
        <div className="knob-grid">
          <Knob label="Simulations">
            <div className="pill-row" style={{ marginBottom: 0 }}>
              {SIM_CHOICES.map((n) => (
                <button key={n} className={sims === n ? "active" : ""} onClick={() => setSims(n)}>
                  {n >= 1000 ? `${n / 1000}k` : n}
                </button>
              ))}
            </div>
          </Knob>

          <Knob
            label="Team strength"
            hint={`${Math.round((1 - knobs.blend) * 100)}% results / ${Math.round(knobs.blend * 100)}% projections${blend == null ? " (auto)" : ""}`}
          >
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(knobs.blend * 100)}
              onChange={(e) => setBlend(Number(e.target.value) / 100)}
            />
            <div className="range-ends">
              <span>results</span>
              <span>projections</span>
            </div>
          </Knob>

          <Knob
            label="Recency weighting"
            hint={halfLife == null ? "off — full season counts equally" : `half-life ${halfLife} wk`}
          >
            <input
              type="range"
              min={1}
              max={11}
              value={halfLife ?? 11}
              onChange={(e) => {
                const v = Number(e.target.value);
                setHalfLife(v >= 11 ? null : v);
              }}
              disabled={gamesPlayed < 2}
            />
            <div className="range-ends">
              <span>ride the hot streak</span>
              <span>full season</span>
            </div>
          </Knob>

          <Knob
            label="Score volatility"
            hint={`σ = ${volatility ?? result.sd} pts${volatility == null ? ` (auto${defaultSd ? ", observed" : ""})` : ""}`}
          >
            <input
              type="range"
              min={10}
              max={45}
              value={volatility ?? result.sd}
              onChange={(e) => setVolatility(Number(e.target.value))}
            />
            <div className="range-ends">
              <span>chalk</span>
              <span>chaos</span>
            </div>
          </Knob>

          <Knob label="Playoff spots" hint={playoffTeams == null ? "from league settings" : "override"}>
            <div className="pill-row" style={{ marginBottom: 0 }}>
              {[4, 6, 8].map((n) => (
                <button
                  key={n}
                  className={knobs.playoffTeams === n ? "active" : ""}
                  onClick={() => setPlayoffTeams(n === leaguePlayoffTeams ? null : n)}
                >
                  {n}
                </button>
              ))}
              <button className={medianWins ? "active" : ""} onClick={() => setMedianWins((v) => !v)}
                title="Each week, beating the league median score earns an extra win">
                + median wins
              </button>
            </div>
          </Knob>

          <Knob label="Dice" hint={`seed ${seed}`}>
            <div className="pill-row" style={{ marginBottom: 0 }}>
              <button onClick={() => setSeed((s) => s + 1)}>🎲 re-roll</button>
              {anyWhatIf && (
                <button
                  onClick={() => {
                    setForced({});
                    setBoosts({});
                  }}
                >
                  ✕ clear what-ifs
                </button>
              )}
            </div>
          </Knob>
        </div>
        <p className="muted small" style={{ marginTop: 10, marginBottom: 0 }}>
          Weekly scores drawn from Normal(strength, σ). Strength blends your actual weekly scoring
          with optimal-lineup projections{myStrength ? ` — yours: ${myStrength.resultsPpg} results / ${myStrength.projPpg} proj` : ""}.
          Standings tiebreak: wins, then points-for. Bracket reseeds each round.
        </p>
      </div>

      {myRosterId != null && result.leverage.length > 0 && (
        <div className="card section">
          <h2>Your remaining schedule — what each game is worth</h2>
          <p className="muted small">
            Playoff odds conditioned on winning vs losing each game. Big gaps = must-wins. Click
            W/L to lock an outcome into the simulation.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Week</th>
                  <th>Opponent</th>
                  <th className="right">Win prob</th>
                  <th className="right">Odds if you win</th>
                  <th className="right">Odds if you lose</th>
                  <th className="right">Leverage</th>
                  <th>Force</th>
                </tr>
              </thead>
              <tbody>
                {result.leverage.map((g) => {
                  const swing = Math.round((g.oddsIfWin - g.oddsIfLose) * 10) / 10;
                  return (
                    <tr key={g.week}>
                      <td className="num">{g.week}</td>
                      <td>{byRoster.get(g.opponent)?.teamName ?? `Roster ${g.opponent}`}</td>
                      <td className="right num">{g.forced ? "—" : `${g.winPct}%`}</td>
                      <td className="right num delta-up">{g.oddsIfWin}%</td>
                      <td className="right num delta-down">{g.oddsIfLose}%</td>
                      <td className="right num">
                        <strong className={swing >= 15 ? "delta-up" : ""}>+{swing}</strong>
                        {swing >= 15 && " 🔥"}
                      </td>
                      <td>
                        <span className="force-pills">
                          <button
                            className={g.forced === "W" ? "on-w" : ""}
                            onClick={() => cycleForce(g.week, "W")}
                            title="Force a win this week"
                          >
                            W
                          </button>
                          <button
                            className={g.forced === "L" ? "on-l" : ""}
                            onClick={() => cycleForce(g.week, "L")}
                            title="Force a loss this week"
                          >
                            L
                          </button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card section">
        <h2>League playoff picture</h2>
        <p className="muted small">
          Boost (±pts/wk) simulates a trade or injury — "what if they add a stud" without leaving
          the cockpit.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Team</th>
                <th className="right">Playoffs</th>
                <th></th>
                {result.byes > 0 && <th className="right">Bye</th>}
                <th className="right">Title</th>
                <th className="right">Proj wins</th>
                <th className="right">Avg seed</th>
                <th className="right">Strength</th>
                <th className="right">Boost</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((t) => {
                const info = byRoster.get(t.rosterId);
                const strength = result.strengths.find((s) => s.rosterId === t.rosterId);
                const boost = boosts[t.rosterId] ?? 0;
                return (
                  <tr key={t.rosterId} className={info?.isMine ? "mine" : ""}>
                    <td>
                      <strong>{info?.teamName}</strong>
                      {info?.isMine && <span className="small" style={{ color: "var(--s5-aqua)" }}> ← you</span>}
                    </td>
                    <td className="right num">{t.playoffPct}%</td>
                    <td>
                      <MiniBar pct={t.playoffPct} mine={info?.isMine} />
                    </td>
                    {result.byes > 0 && <td className="right num">{t.byePct}%</td>}
                    <td className="right num">{t.titlePct}%</td>
                    <td className="right num">{t.avgWins.toFixed(1)}</td>
                    <td className="right num">{t.avgSeed.toFixed(1)}</td>
                    <td className="right num muted">{strength ? Math.round(strength.mean) : "—"}</td>
                    <td className="right">
                      <span className="boost-ctl num">
                        <button onClick={() => setBoost(t.rosterId, -2)} title="-2 ppg">−</button>
                        <span className={boost > 0 ? "delta-up" : boost < 0 ? "delta-down" : "muted"}>
                          {boost > 0 ? `+${boost}` : boost || "0"}
                        </span>
                        <button onClick={() => setBoost(t.rosterId, 2)} title="+2 ppg">+</button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {mine && (
        <div className="card">
          <h2>Your seed distribution</h2>
          <p className="muted small">
            Where you finish the regular season across {result.sims.toLocaleString()} simulated
            seasons. Seeds 1–{knobs.playoffTeams} make the playoffs.
          </p>
          <div className="seed-dist">
            {mine.seedDist.map((p, i) => (
              <div key={i} className="seed-row">
                <span className={`num seed-label${i < knobs.playoffTeams ? " in" : ""}`}>#{i + 1}</span>
                <MiniBar pct={p * 100} mine={i < knobs.playoffTeams} />
                <span className="num muted small">{(p * 100).toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
