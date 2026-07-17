import { useMemo } from "react";
import { useAppData } from "../AppContext";
import { PlayerCell, StatTile } from "../components";
import { winProbability } from "../lib/analysis";
import { isUnavailable, startingSlots } from "../lib/lineup";
import { PosChip } from "../components";

export function Matchup() {
  const { bundle, teams, myTeam, projPts } = useAppData();

  const data = useMemo(() => {
    if (!myTeam || bundle.matchups.length === 0) return null;
    const mine = bundle.matchups.find((m) => m.roster_id === myTeam.rosterId);
    if (!mine || mine.matchup_id == null) return null;
    const theirs = bundle.matchups.find(
      (m) => m.matchup_id === mine.matchup_id && m.roster_id !== myTeam.rosterId,
    );
    if (!theirs) return null;
    // Ruled-out starters count as 0, matching the My Team projection.
    const proj = (m: typeof mine) =>
      (m.starters ?? [])
        .filter((s) => s && s !== "0")
        .reduce((s, id) => s + (isUnavailable(bundle.players, id) ? 0 : projPts(id)), 0);
    return {
      mine,
      theirs,
      myProj: Math.round(proj(mine) * 10) / 10,
      theirProj: Math.round(proj(theirs) * 10) / 10,
      opponent: teams.find((t) => t.rosterId === theirs.roster_id) ?? null,
    };
  }, [bundle, teams, myTeam, projPts]);

  if (bundle.isOffseason || !data) {
    return (
      <div className="card">
        <h2>{bundle.isOffseason ? "It’s the offseason" : "No matchup found"}</h2>
        <p className="muted">
          {bundle.isOffseason
            ? "No weekly matchup right now. Use the Waivers, Trades and Dynasty tabs to build for next season — championships are won in the offseason."
            : "Couldn’t pair your roster with an opponent this week (bye week in a median league, or matchups not posted yet)."}
        </p>
      </div>
    );
  }

  const winPct = winProbability(data.myProj, data.theirProj);
  const slots = startingSlots(bundle.league);
  const rows = Math.max(data.mine.starters?.length ?? 0, data.theirs.starters?.length ?? 0);

  return (
    <div>
      <div className="stat-row">
        <StatTile label="Your projection" value={data.myProj} sub={myTeam?.teamName} />
        <StatTile
          label="Win probability"
          value={`${winPct}%`}
          sub={
            <div className="winprob" style={{ marginTop: 4 }} role="img" aria-label={`Win probability ${winPct}%`}>
              <div className="a" style={{ width: `${winPct}%` }} />
              <div className="b" style={{ width: `${100 - winPct}%` }} />
            </div>
          }
        />
        <StatTile label="Their projection" value={data.theirProj} sub={`${data.opponent?.teamName ?? "?"} (@${data.opponent?.ownerName ?? "?"})`} />
      </div>

      <div className="card">
        <h2>Week {bundle.week}: head to head</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Slot</th>
                <th>You</th>
                <th className="right">Proj</th>
                <th></th>
                <th>Them</th>
                <th className="right">Proj</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: rows }, (_, i) => {
                const a = data.mine.starters?.[i];
                const b = data.theirs.starters?.[i];
                const ap = a && a !== "0" ? projPts(a) : 0;
                const bp = b && b !== "0" ? projPts(b) : 0;
                return (
                  <tr key={i}>
                    <td><PosChip pos={slots[i] ?? "?"} /></td>
                    <td>{a && a !== "0" ? <PlayerCell playerId={a} /> : <span className="muted">Empty</span>}</td>
                    <td className={`right num ${ap > bp ? "delta-up" : ""}`}>{ap.toFixed(1)}</td>
                    <td className="muted small">vs</td>
                    <td>{b && b !== "0" ? <PlayerCell playerId={b} /> : <span className="muted">Empty</span>}</td>
                    <td className={`right num ${bp > ap ? "delta-up" : ""}`}>{bp.toFixed(1)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
