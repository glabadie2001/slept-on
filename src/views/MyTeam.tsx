import { useMemo } from "react";
import { useAppData } from "../AppContext";
import { PlayerCell, PosChip, StatTile } from "../components";
import { injuryAlerts, positionalNeeds } from "../lib/analysis";
import { lineupAdvice, startingSlots } from "../lib/lineup";
import { holdBadge, irAdvice, rosterCrunch, taxiAdvice, upgradePairs, weakestHolds } from "../lib/roster";

const BADGE_LABEL = {
  "young-core": <span className="hold-badge young" title="Age ≤ 24 with real value — build around him">🌱 core</span>,
  "sell-window": <span className="hold-badge sell" title="27+ with high value — trade value only falls from here">⏳ sell</span>,
} as const;

export function MyTeam() {
  const { bundle, myTeam, values, projPts } = useAppData();

  const analysis = useMemo(() => {
    if (!myTeam) return null;
    const roster = myTeam.roster;
    const advice = lineupAdvice(
      bundle.league,
      roster.starters ?? [],
      roster.players ?? [],
      bundle.players,
      projPts,
    );
    const alerts = injuryAlerts(roster, bundle.players);
    const needs = positionalNeeds(bundle.league, roster, bundle.players, values);
    const ir = irAdvice(bundle.league, roster, bundle.players);
    const upgrades = upgradePairs(roster, bundle.rosters, bundle.players, values, projPts).slice(0, 5);
    const taxi = taxiAdvice(bundle.league, roster, bundle.players, values, projPts);
    const crunch = rosterCrunch(bundle.league, roster, bundle.tradedPicks, bundle.league.season);
    const cutList =
      crunch.cutsNeeded > 0
        ? weakestHolds(roster, bundle.players, values, projPts).slice(0, crunch.cutsNeeded)
        : [];
    return { advice, alerts, needs, ir, upgrades, taxi, crunch, cutList };
  }, [bundle, myTeam, values, projPts]);

  if (!myTeam || !analysis) {
    return (
      <div className="card">
        <h2>Couldn’t find your roster</h2>
        <p className="muted">
          No roster in this league is owned by your Sleeper account. If you co-own a team, ask the
          commissioner to add you as co-owner, or reconnect with the account that owns the team.
        </p>
      </div>
    );
  }

  const { advice, alerts, needs, ir, upgrades, taxi, crunch, cutList } = analysis;
  const slots = startingSlots(bundle.league);
  const roster = myTeam.roster;
  const starters = (roster.starters ?? []).filter((s) => s && s !== "0");
  const starterSet = new Set(starters);
  const bench = (roster.players ?? []).filter(
    (id) => !starterSet.has(id) && !(roster.reserve ?? []).includes(id) && !(roster.taxi ?? []).includes(id),
  );

  return (
    <div>
      <div className="stat-row">
        <StatTile label="Current lineup proj" value={advice.currentProjected} sub={`week ${bundle.week}`} />
        <StatTile
          label="Optimal lineup proj"
          value={advice.optimal.totalProjected}
          sub={
            advice.moves.length > 0 ? (
              <span className="delta-up">▲ +{Math.max(0, advice.optimal.totalProjected - advice.currentProjected).toFixed(1)} available</span>
            ) : (
              "you're optimal ✓"
            )
          }
        />
        <StatTile label="Injury alerts" value={alerts.length} sub={`${alerts.filter((a) => a.isStarter).length} in lineup`} />
        <StatTile label="Weakest position" value={needs[0]?.position ?? "—"} sub={`avg starter value ${needs[0]?.quality ?? "—"}`} />
        <StatTile
          label="Roster spots"
          value={`${crunch.active}/${crunch.capacity}`}
          sub={
            crunch.cutsNeeded > 0
              ? `${crunch.incomingPicks} picks incoming ${crunch.nextSeason} → ${crunch.cutsNeeded} cut${crunch.cutsNeeded > 1 ? "s" : ""} needed`
              : `${crunch.open} open · ${crunch.incomingPicks} picks incoming ${crunch.nextSeason} ✓`
          }
        />
      </div>

      {(ir.length > 0 || upgrades.length > 0 || cutList.length > 0) && (
        <div className="card section">
          <h2>Roster moves</h2>
          {cutList.length > 0 && (
            <p className="muted small" style={{ marginTop: 0 }}>
              📉 Roster crunch: {crunch.incomingPicks} rookie picks incoming in {crunch.nextSeason} vs {crunch.open} open
              spot{crunch.open === 1 ? "" : "s"} — weakest holds if you need to cut:{" "}
              {cutList.map((c) => bundle.players[c.playerId]?.full_name).join(", ")}.
            </p>
          )}
          {ir.length > 0 && (
            <ul className="advice-list">
              {ir.map((a) => (
                <li key={a.playerId}>
                  <span className="icon">{a.kind === "stash" ? "🏥" : "🔓"}</span>
                  <div>
                    {a.kind === "stash" ? "Move " : "Activate "}
                    <strong>{bundle.players[a.playerId]?.full_name}</strong>
                    {a.kind === "stash" ? " to IR" : " off IR"} — {a.reason}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {upgrades.length > 0 && (
            <>
              <p className="muted small" style={{ margin: "8px 0 0" }}>
                Free agents who outclass a bench hold (dynasty value + weekly projection, with a margin — drops are forever):
              </p>
              <ul className="advice-list">
                {upgrades.map((u) => (
                  <li key={u.dropId}>
                    <span className="icon">💱</span>
                    <div>
                      Drop <strong>{bundle.players[u.dropId]?.full_name}</strong> for FA{" "}
                      <strong>{bundle.players[u.addId]?.full_name}</strong> <PosChip pos={u.position} />{" "}
                      {u.netValue !== 0 && (
                        <span className={u.netValue > 0 ? "delta-up" : "delta-down"}>
                          {u.netValue > 0 ? "+" : ""}{u.netValue} value
                        </span>
                      )}{" "}
                      {u.netProj !== 0 && (
                        <span className={u.netProj > 0 ? "delta-up" : "delta-down"}>
                          {u.netProj > 0 ? "+" : ""}{u.netProj} proj
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {taxi.slots > 0 && (
        <div className="card section">
          <h2>
            Taxi squad <span className="muted small">{taxi.used}/{taxi.slots} slots used</span>
          </h2>
          {(myTeam.roster.taxi ?? []).length > 0 && (
            <div style={{ marginBottom: 8 }}>
              {(myTeam.roster.taxi ?? []).map((id) => (
                <div key={id} style={{ padding: "4px 0" }}>
                  <PlayerCell playerId={id} showValue />
                </div>
              ))}
            </div>
          )}
          {taxi.moves.length === 0 ? (
            <p className="muted small" style={{ margin: 0 }}>No taxi moves suggested — your stash looks right.</p>
          ) : (
            <ul className="advice-list">
              {taxi.moves.map((m) => (
                <li key={`${m.kind}-${m.playerId}`}>
                  <span className="icon">{m.kind === "promote" ? "⬆️" : "🚕"}</span>
                  <div>
                    {m.kind === "promote" ? "Promote " : "Stash "}
                    <strong>{bundle.players[m.playerId]?.full_name}</strong>
                    {m.kind === "promote" ? " off the taxi squad" : " on the taxi squad"} — {m.reason}
                    {m.irreversible && (
                      <div className="irrev-warning">⚠ Irreversible: once activated he can never return to taxi. Only do this if he's starting.</div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {advice.moves.length > 0 && (
        <div className="card section">
          <h2>Start/sit advice</h2>
          <ul className="advice-list">
            {advice.moves.map((m, i) => (
              <li key={i}>
                <span className="icon">🔁</span>
                <div>
                  <strong>{bundle.players[m.inId]?.full_name}</strong> into your{" "}
                  <PosChip pos={m.slot} /> slot
                  {m.outId ? (
                    <>
                      {" "}
                      over <strong>{bundle.players[m.outId]?.full_name}</strong>
                    </>
                  ) : (
                    <> (currently empty!)</>
                  )}{" "}
                  {m.gain !== 0 && (
                    <span className={m.gain > 0 ? "delta-up" : "delta-down"}>
                      {m.gain > 0 ? "+" : ""}
                      {m.gain} proj pts
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {alerts.length > 0 && (
        <div className="card section">
          <h2>Injury report</h2>
          <ul className="advice-list">
            {alerts.map((a) => (
              <li key={a.playerId}>
                <span className="icon">{a.severity === "critical" ? "⛔" : a.severity === "serious" ? "🚑" : "⚠️"}</span>
                <div>
                  <strong>{bundle.players[a.playerId]?.full_name}</strong> — {a.status}
                  {a.note ? ` (${a.note})` : ""}
                  {a.isStarter && (
                    <span style={{ color: "var(--critical)", fontWeight: 600 }}> · currently in your lineup</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid cols-2">
        <div className="card">
          <h2>Starters</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Slot</th><th>Player</th><th className="right">Proj</th><th className="right">Value</th></tr>
              </thead>
              <tbody>
                {(roster.starters ?? []).map((id, i) => (
                  <tr key={i}>
                    <td><PosChip pos={slots[i] ?? "?"} /></td>
                    <td>{id && id !== "0" ? <PlayerCell playerId={id} /> : <span className="muted">Empty</span>}</td>
                    <td className="right num">{id && id !== "0" ? projPts(id).toFixed(1) : "—"}</td>
                    <td className="right num">{id && id !== "0" ? (values[id]?.value ?? 0) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card">
          <h2>Bench{roster.reserve?.length ? " & IR" : ""}</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Player</th><th></th><th className="right">Proj</th><th className="right">Value</th></tr>
              </thead>
              <tbody>
                {bench
                  .sort((a, b) => (values[b]?.value ?? 0) - (values[a]?.value ?? 0))
                  .map((id) => {
                    const badge = holdBadge(bundle.players[id]?.age, values[id]?.value ?? 0);
                    return (
                      <tr key={id}>
                        <td><PlayerCell playerId={id} /></td>
                        <td>{badge ? BADGE_LABEL[badge] : null}</td>
                        <td className="right num">{projPts(id).toFixed(1)}</td>
                        <td className="right num">{values[id]?.value ?? 0}</td>
                      </tr>
                    );
                  })}
                {(roster.reserve ?? []).map((id) => (
                  <tr key={id}>
                    <td><PlayerCell playerId={id} /></td>
                    <td><span className="muted small">IR slot</span></td>
                    <td className="right num">{projPts(id).toFixed(1)}</td>
                    <td className="right num">{values[id]?.value ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
