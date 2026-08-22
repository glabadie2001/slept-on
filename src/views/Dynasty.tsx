import { useMemo } from "react";
import { useAppData } from "../AppContext";
import { PlayerCell, StatTile } from "../components";
import { pickLabel } from "../lib/value";
import { ValuesPanel } from "./ValuesPanel";

export function Dynasty() {
  const { bundle, teams, myTeam, values, pickVal } = useAppData();

  const outlook = useMemo(() => {
    const rows = teams.map((t) => {
      const ids = (t.roster.players ?? []).filter((id) => bundle.players[id]);
      const core = ids
        .map((id) => ({ id, v: values[id]?.value ?? 0, age: bundle.players[id]?.age ?? 27 }))
        .sort((a, b) => b.v - a.v)
        .slice(0, 12);
      const totalV = core.reduce((s, c) => s + c.v, 0);
      // Value-weighted age of the core — the real "team age".
      const wAge = totalV > 0 ? core.reduce((s, c) => s + c.age * c.v, 0) / totalV : 27;
      const myPicks = bundle.tradedPicks.filter((p) => p.owner_id === t.rosterId);
      const lostPicks = bundle.tradedPicks.filter(
        (p) => p.roster_id === t.rosterId && p.owner_id !== t.rosterId,
      );
      const pickCapital = myPicks.reduce((s, p) => s + pickVal(p), 0);
      return { team: t, coreAge: Math.round(wAge * 10) / 10, totalV: Math.round(totalV), myPicks, lostPicks, pickCapital: Math.round(pickCapital) };
    });
    return rows.sort((a, b) => b.totalV - a.totalV);
  }, [bundle, teams, values, pickVal]);

  const my = outlook.find((o) => o.team.isMine);
  const avgAge = outlook.reduce((s, o) => s + o.coreAge, 0) / Math.max(1, outlook.length);

  const window = my
    ? my.coreAge < avgAge - 0.7
      ? { label: "REBUILD AHEAD OF SCHEDULE", note: "Your core is younger than the league — accumulate picks and let them grow." }
      : my.coreAge > avgAge + 0.7
        ? { label: "WIN NOW OR TEAR DOWN", note: "Your core is older than the league. Either push chips in or sell veterans for youth + picks." }
        : { label: "FLEXIBLE", note: "Your core age is league-average — let value dictate every move." }
    : null;

  const myYoung = myTeam
    ? (myTeam.roster.players ?? [])
        .filter((id) => (bundle.players[id]?.age ?? 99) <= 24 && (values[id]?.value ?? 0) >= 5)
        .sort((a, b) => (values[b]?.value ?? 0) - (values[a]?.value ?? 0))
    : [];

  return (
    <div>
      <ValuesPanel />
      <div className="stat-row">
        <StatTile label="Your core age" value={my?.coreAge ?? "—"} sub={`league avg ${avgAge.toFixed(1)} (value-weighted, top 12)`} />
        <StatTile label="Contention window" value={window?.label ?? "—"} sub={window?.note} />
        <StatTile label="Draft capital" value={my?.pickCapital ?? 0} sub={`${my?.myPicks.length ?? 0} acquired picks${my?.lostPicks.length ? ` · ${my.lostPicks.length} traded away` : ""}`} />
      </div>

      <div className="card section">
        <h2>Dynasty landscape</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Team</th>
                <th className="right">Core value</th>
                <th className="right">Core age</th>
                <th>Window</th>
                <th>Extra picks</th>
              </tr>
            </thead>
            <tbody>
              {outlook.map((o) => (
                <tr key={o.team.rosterId} className={o.team.isMine ? "mine" : ""}>
                  <td>
                    <strong>{o.team.teamName}</strong>{" "}
                    {o.team.isMine && <span className="small" style={{ color: "var(--s5-aqua)" }}>← you</span>}
                  </td>
                  <td className="right num">{o.totalV}</td>
                  <td className="right num">{o.coreAge}</td>
                  <td className="muted small">
                    {o.coreAge < avgAge - 0.7 ? "🌱 rebuilding" : o.coreAge > avgAge + 0.7 ? "⏳ aging out" : "⚖️ balanced"}
                  </td>
                  <td className="muted small">{o.myPicks.map(pickLabel).join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>Your young core</h2>
          <p className="muted small">Age ≤ 24 with real value — the players your rebuild is built on. Do not trade these for aging veterans.</p>
          {myYoung.length === 0 && <p className="muted">No young assets with value yet — target them in every deal.</p>}
          {myYoung.map((id) => (
            <div key={id} style={{ padding: "4px 0" }}>
              <PlayerCell playerId={id} showValue />
            </div>
          ))}
        </div>
        <div className="card">
          <h2>Sell-window veterans</h2>
          <p className="muted small">Your players aged 27+ whose value is still high — their trade value only goes down from here.</p>
          {(myTeam?.roster.players ?? [])
            .filter((id) => (bundle.players[id]?.age ?? 0) >= 27 && (values[id]?.value ?? 0) >= 10)
            .sort((a, b) => (values[b]?.value ?? 0) - (values[a]?.value ?? 0))
            .map((id) => (
              <div key={id} style={{ padding: "4px 0" }}>
                <PlayerCell playerId={id} showValue />
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
