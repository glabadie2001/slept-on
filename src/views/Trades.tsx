import { useMemo, useState } from "react";
import { useAppData } from "../AppContext";
import { PlayerCell } from "../components";
import { tradeLedger, tradeSuggestions } from "../lib/analysis";
import { evaluateTrade } from "../lib/analysis";
import { pickLabel } from "../lib/value";
import { ValuesPanel } from "./ValuesPanel";

export function Trades() {
  const { bundle, teams, myTeam, values, pickVal } = useAppData();
  const [give, setGive] = useState<string[]>([]);
  const [get, setGet] = useState<string[]>([]);
  const [partnerRosterId, setPartnerRosterId] = useState<number | null>(null);

  const suggestions = useMemo(() => {
    if (!myTeam) return [];
    return tradeSuggestions(
      bundle.league,
      myTeam.roster,
      bundle.rosters.filter((r) => r.roster_id !== myTeam.rosterId),
      bundle.players,
      values,
    );
  }, [bundle, myTeam, values]);

  const ledger = useMemo(
    () => tradeLedger(bundle.transactions, values, bundle.league.season, pickVal),
    [bundle, values, pickVal],
  );

  const byRoster = new Map(teams.map((t) => [t.rosterId, t]));
  const partner = partnerRosterId != null ? byRoster.get(partnerRosterId) : null;
  const evalResult =
    give.length || get.length
      ? evaluateTrade(give, get, [], [], values, bundle.league.season, pickVal)
      : null;

  const toggle = (list: string[], setList: (v: string[]) => void, id: string) =>
    setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const verdictClass = (v: string) =>
    v.includes("win") || v === "Favorable" ? "win" : v.includes("loss") || v === "Unfavorable" ? "loss" : "fair";

  return (
    <div>
      <ValuesPanel />
      {suggestions.length > 0 && (
        <div className="card section">
          <h2>Suggested trades</h2>
          <p className="muted small">
            Pairs where a partner's surplus matches your need (and vice versa), close enough in value
            that a real manager might say yes.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Partner</th><th>You give</th><th>You get</th><th className="right">Value swing</th><th>Why</th></tr>
              </thead>
              <tbody>
                {suggestions.map((s, i) => (
                  <tr key={i}>
                    <td>{byRoster.get(s.targetRosterId)?.teamName}</td>
                    <td>{s.give.map((id) => <PlayerCell key={id} playerId={id} showValue />)}</td>
                    <td>{s.get.map((id) => <PlayerCell key={id} playerId={id} showValue />)}</td>
                    <td className="right num delta-up">+{(s.getValue - s.giveValue).toFixed(1)}</td>
                    <td className="muted small">{s.rationale}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card section">
        <h2>Trade analyzer</h2>
        <p className="muted small">Pick a partner, click players on each side, get a verdict from the dynasty value model.</p>
        <div className="pill-row">
          {teams
            .filter((t) => !t.isMine)
            .map((t) => (
              <button
                key={t.rosterId}
                className={partnerRosterId === t.rosterId ? "active" : ""}
                onClick={() => {
                  setPartnerRosterId(t.rosterId);
                  setGet([]);
                }}
              >
                {t.teamName}
              </button>
            ))}
        </div>
        {evalResult && (
          <p>
            You give <strong className="num">{evalResult.giveValue}</strong> · you get{" "}
            <strong className="num">{evalResult.getValue}</strong> —{" "}
            <span className={`verdict ${verdictClass(evalResult.verdict)}`}>{evalResult.verdict}</span>
          </p>
        )}
        <div className="grid cols-2">
          <div>
            <h3>Your roster (click to offer)</h3>
            <div className="table-wrap" style={{ maxHeight: 360, overflowY: "auto" }}>
              <table>
                <tbody>
                  {(myTeam?.roster.players ?? [])
                    .slice()
                    .sort((a, b) => (values[b]?.value ?? 0) - (values[a]?.value ?? 0))
                    .map((id) => (
                      <tr key={id} className={`clickable${give.includes(id) ? " mine" : ""}`} onClick={() => toggle(give, setGive, id)}>
                        <td>{give.includes(id) ? "✓ " : ""}</td>
                        <td><PlayerCell playerId={id} showValue /></td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <h3>{partner ? `${partner.teamName} (click to request)` : "Pick a partner above"}</h3>
            {partner && (
              <div className="table-wrap" style={{ maxHeight: 360, overflowY: "auto" }}>
                <table>
                  <tbody>
                    {(partner.roster.players ?? [])
                      .slice()
                      .sort((a, b) => (values[b]?.value ?? 0) - (values[a]?.value ?? 0))
                      .map((id) => (
                        <tr key={id} className={`clickable${get.includes(id) ? " mine" : ""}`} onClick={() => toggle(get, setGet, id)}>
                          <td>{get.includes(id) ? "✓ " : ""}</td>
                          <td><PlayerCell playerId={id} showValue /></td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {ledger.length > 0 && (
        <div className="card">
          <h2>Trade ledger</h2>
          <p className="muted small">Completed trades, graded by today’s values. Yes, including that one.</p>
          {ledger.map(({ tx, perRoster }) => (
            <div key={tx.transaction_id} style={{ borderBottom: "1px solid var(--grid)", padding: "8px 0" }}>
              {Object.entries(perRoster).map(([rid, rec]) => {
                const t = byRoster.get(Number(rid));
                return (
                  <p key={rid}>
                    <strong>{t?.teamName ?? `Roster ${rid}`}</strong> received{" "}
                    {[
                      ...rec.in.map((id) => bundle.players[id]?.full_name ?? id),
                      ...rec.picksIn.map(pickLabel),
                    ].join(", ") || "nothing"}{" "}
                    <span className={rec.net >= 0 ? "delta-up" : "delta-down"}>
                      ({rec.net >= 0 ? "+" : ""}
                      {rec.net} value)
                    </span>
                    {t?.isMine && <span className="muted small"> ← your side</span>}
                  </p>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
