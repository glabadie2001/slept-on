import { useMemo, useState } from "react";
import { useAppData } from "../AppContext";
import { PlayerCell } from "../components";
import { positionalNeeds, waiverTargets } from "../lib/analysis";

const POS_FILTERS = ["ALL", "QB", "RB", "WR", "TE", "K", "DEF"];

export function Waivers() {
  const { bundle, myTeam, values, projPts } = useAppData();
  const [posFilter, setPosFilter] = useState("ALL");

  const { targets, needs } = useMemo(() => {
    const needs = myTeam
      ? positionalNeeds(bundle.league, myTeam.roster, bundle.players, values)
      : [];
    const targets = waiverTargets(
      bundle.rosters,
      bundle.players,
      values,
      bundle.trendingAdds,
      needs,
      projPts,
    );
    return { targets, needs };
  }, [bundle, myTeam, values, projPts]);

  const filtered = targets.filter(
    (t) => posFilter === "ALL" || bundle.players[t.playerId]?.position === posFilter,
  );
  const faab = bundle.league.settings.waiver_budget ?? 0;
  const faabUsed = myTeam?.roster.settings.waiver_budget_used ?? 0;

  return (
    <div>
      <div className="grid cols-2 section">
        <div className="card">
          <h3>Your positional needs</h3>
          {needs.slice(0, 3).map((n) => (
            <p key={n.position}>
              <strong>{n.position}</strong>{" "}
              <span className="muted small">avg starter value {n.quality} — weakest first</span>
            </p>
          ))}
        </div>
        <div className="card">
          <h3>FAAB</h3>
          <p>
            <strong className="num">${faab - faabUsed}</strong>{" "}
            <span className="muted small">remaining of ${faab}</span>
          </p>
          <p className="muted small">
            Rule of thumb: 20–40% on a league-winner, 5–10% on a solid starter, $1–2 on stashes.
          </p>
        </div>
      </div>

      <div className="card">
        <h2>Waiver targets</h2>
        <p className="muted small">
          Free agents ranked by dynasty value, weekly projection and league-wide add trends — boosted
          when they fill your weakest positions.
        </p>
        <div className="pill-row">
          {POS_FILTERS.map((p) => (
            <button key={p} className={posFilter === p ? "active" : ""} onClick={() => setPosFilter(p)}>
              {p}
            </button>
          ))}
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Player</th>
                <th className="right">Proj</th>
                <th className="right">Value</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 25).map((t) => (
                <tr key={t.playerId}>
                  <td><PlayerCell playerId={t.playerId} /></td>
                  <td className="right num">{projPts(t.playerId).toFixed(1)}</td>
                  <td className="right num">{values[t.playerId]?.value ?? 0}</td>
                  <td className="muted small">{t.reason}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={4} className="muted">No notable free agents at this position.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
