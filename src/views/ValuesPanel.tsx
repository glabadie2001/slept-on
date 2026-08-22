import { useState } from "react";
import { useAppData } from "../AppContext";
import { fantasyCalcParams } from "../api/marketValues";

/**
 * Market value controls, shared by the Trades and Dynasty tabs: sync
 * FantasyCalc, paste-import a KeepTradeCut-style list, blend vs the heuristic.
 */
export function ValuesPanel() {
  const {
    bundle,
    market,
    marketBlend,
    marketSyncing,
    marketError,
    setMarketBlend,
    syncMarket,
    importMarket,
    clearMarket,
  } = useAppData();
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importNote, setImportNote] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const params = fantasyCalcParams(bundle.league);

  const applyImport = () => {
    try {
      const res = importMarket(importText);
      const skipped = res.unmatched.length;
      setImportNote(
        `Matched ${res.matched} of ${res.total} lines${skipped ? ` — unmatched: ${res.unmatched.slice(0, 5).join(", ")}${skipped > 5 ? "…" : ""}` : ""}`,
      );
      setImportError(null);
      setShowImport(false);
      setImportText("");
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    }
  };

  const age = market ? Math.round((Date.now() - market.fetchedAt) / 3_600_000) : 0;

  return (
    <div className="card section values-panel">
      <h2>Value model</h2>
      <div className="values-row">
        <div className="values-status">
          {market ? (
            <>
              <span className="source-chip live">{market.label}</span>
              <span className="muted small">
                {market.matched.toLocaleString()} players
                {market.picks.length > 0 && ` · ${market.picks.length} pick tiers`}
                {market.source !== "import" && ` · synced ${age < 1 ? "just now" : `${age}h ago`}`}
              </span>
            </>
          ) : (
            <>
              <span className="source-chip">Heuristic only</span>
              <span className="muted small">
                production × age curve — sync a market source to ground values in real trade prices
              </span>
            </>
          )}
        </div>
        <div className="pill-row" style={{ marginBottom: 0 }}>
          <button onClick={() => void syncMarket()} disabled={marketSyncing}>
            {marketSyncing ? "Syncing…" : bundle.demo ? "Sync demo market" : "Sync FantasyCalc"}
          </button>
          <button onClick={() => setShowImport((v) => !v)}>Paste import</button>
          {market && <button onClick={clearMarket}>Clear</button>}
        </div>
      </div>

      {market && (
        <div className="knob" style={{ maxWidth: 420, marginTop: 10 }}>
          <div className="knob-label">
            Blend
            <span className="muted small">
              {" "}· {Math.round(marketBlend * 100)}% market / {Math.round((1 - marketBlend) * 100)}% heuristic
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(marketBlend * 100)}
            onChange={(e) => setMarketBlend(Number(e.target.value) / 100)}
          />
          <div className="range-ends">
            <span>trust the model</span>
            <span>trust the market</span>
          </div>
        </div>
      )}

      {!bundle.demo && !market && (
        <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>
          FantasyCalc will be queried as {params.numQbs === 2 ? "superflex" : "1QB"} ·{" "}
          {params.ppr} PPR · {params.numTeams} teams (derived from your league settings).
        </p>
      )}

      {showImport && (
        <div style={{ marginTop: 10 }}>
          <textarea
            className="import-box"
            rows={6}
            placeholder={"One entry per line — works with KeepTradeCut-style lists:\nJa'Marr Chase, 9999\nBijan Robinson\t9600\n12. Jahmyr Gibbs 9400\n2027 1st, 4500"}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
          />
          <div className="pill-row" style={{ marginTop: 6, marginBottom: 0 }}>
            <button className="active" onClick={applyImport} disabled={!importText.trim()}>
              Apply import
            </button>
            <button onClick={() => setShowImport(false)}>Cancel</button>
          </div>
        </div>
      )}

      {importNote && <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>{importNote}</p>}
      {(marketError || importError) && <div className="error-box">{marketError ?? importError}</div>}
    </div>
  );
}
