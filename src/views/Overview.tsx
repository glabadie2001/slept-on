import { useMemo } from "react";
import { useAppData } from "../AppContext";
import { MiniBar, PlayerCell, StatTile } from "../components";
import { powerRankings } from "../lib/analysis";

export function Overview() {
  const { bundle, teams, myTeam, values, projPts } = useAppData();

  const ranks = useMemo(
    () => powerRankings(bundle.league, bundle.rosters, bundle.players, values, projPts),
    [bundle, values, projPts],
  );
  const byRoster = new Map(teams.map((t) => [t.rosterId, t]));
  const myRank = ranks.find((r) => r.rosterId === myTeam?.rosterId);
  const maxScore = Math.max(1, ...ranks.map((r) => r.score));

  return (
    <div>
      <div className="stat-row">
        <StatTile
          label="Your power rank"
          value={myRank ? `#${myRank.rank}` : "—"}
          sub={myRank ? `score ${myRank.score}` : ""}
        />
        <StatTile label="Record" value={myTeam?.roster.settings ? `${myTeam.roster.settings.wins}-${myTeam.roster.settings.losses}` : "—"} sub={`${myRank?.fpts ?? 0} pts for`} />
        <StatTile
          label="Roster value"
          value={myRank?.rosterValue ?? "—"}
          sub={`league best: ${Math.max(...ranks.map((r) => r.rosterValue))}`}
        />
        <StatTile
          label={bundle.isOffseason ? "Season" : "Week"}
          value={bundle.isOffseason ? "Offseason" : bundle.week}
          sub={`${bundle.league.season} · ${bundle.league.name}`}
        />
      </div>

      <div className="card section">
        <h2>Power rankings</h2>
        <p className="muted small">
          45% optimal-lineup strength · 30% dynasty roster value · 15% points scored · 10% record
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Team</th>
                <th>Score</th>
                <th></th>
                <th className="right">Record</th>
                <th className="right">Pts for</th>
                <th className="right">Starter proj</th>
                <th className="right">Roster value</th>
              </tr>
            </thead>
            <tbody>
              {ranks.map((r) => {
                const t = byRoster.get(r.rosterId);
                return (
                  <tr key={r.rosterId} className={t?.isMine ? "mine" : ""}>
                    <td className="num">{r.rank}</td>
                    <td>
                      <strong>{t?.teamName}</strong>{" "}
                      <span className="muted small">@{t?.ownerName}</span>
                      {t?.isMine && <span className="small" style={{ color: "var(--s5-aqua)" }}> ← you</span>}
                    </td>
                    <td className="num">{r.score}</td>
                    <td><MiniBar pct={(r.score / maxScore) * 100} mine={t?.isMine} /></td>
                    <td className="right num">{r.record}</td>
                    <td className="right num">{r.fpts}</td>
                    <td className="right num">{r.starterStrength}</td>
                    <td className="right num">{r.rosterValue}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid cols-2">
        {teams.map((t) => {
          const top = (t.roster.players ?? [])
            .slice()
            .sort((a, b) => (values[b]?.value ?? 0) - (values[a]?.value ?? 0))
            .slice(0, 4);
          return (
            <div key={t.rosterId} className="card">
              <h3>
                {t.teamName} {t.isMine && "· YOU"}
              </h3>
              {top.map((id) => (
                <div key={id} style={{ padding: "4px 0" }}>
                  <PlayerCell playerId={id} showValue />
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
