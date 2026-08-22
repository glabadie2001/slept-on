import { useCallback, useMemo, useState } from "react";
import { AppDataProvider, useAppData } from "./AppContext";
import { clearConfig, loadConfig, saveConfig } from "./store/config";
import type { AppConfig } from "./store/config";
import { Setup } from "./views/Setup";
import { Overview } from "./views/Overview";
import { MyTeam } from "./views/MyTeam";
import { Matchup } from "./views/Matchup";
import { Playoffs } from "./views/Playoffs";
import { Waivers } from "./views/Waivers";
import { Trades } from "./views/Trades";
import { Dynasty } from "./views/Dynasty";
import { injuryAlerts } from "./lib/analysis";

const TABS = [
  { id: "overview", label: "Overview", view: Overview },
  { id: "team", label: "My Team", view: MyTeam },
  { id: "matchup", label: "Matchup", view: Matchup },
  { id: "playoffs", label: "Playoffs", view: Playoffs },
  { id: "waivers", label: "Waivers", view: Waivers },
  { id: "trades", label: "Trades", view: Trades },
  { id: "dynasty", label: "Dynasty", view: Dynasty },
] as const;

type TabId = (typeof TABS)[number]["id"];

function Shell({ onDisconnect }: { onDisconnect: () => void }) {
  const { bundle, myTeam, refresh } = useAppData();
  const [tab, setTab] = useState<TabId>("overview");
  const ActiveView = TABS.find((t) => t.id === tab)?.view ?? Overview;

  const hasLineupIssue = useMemo(() => {
    if (!myTeam) return false;
    return injuryAlerts(myTeam.roster, bundle.players).some((a) => a.isStarter && a.severity !== "warning");
  }, [bundle, myTeam]);

  return (
    <div className="shell">
      <div className="topbar">
        <span className="brand">🏈 War Room</span>
        <span className="league-name">
          {bundle.league.name} · {bundle.league.season}
          {bundle.league.settings.type === 2 ? " · Dynasty" : ""}
        </span>
        <span className="spacer" />
        <button className="linklike" onClick={refresh}>↻ Refresh</button>
        <button className="linklike" onClick={onDisconnect}>Switch league</button>
      </div>

      {bundle.demo && (
        <div className="demo-banner">
          📊 <strong>Demo league.</strong> This is generated sample data so you can explore every
          feature — hit “Switch league” to connect your real Sleeper league.
        </div>
      )}

      <nav className="tabs" aria-label="Dashboard sections">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === "team" && hasLineupIssue && <span className="badge-dot" title="Injured player in lineup" />}
          </button>
        ))}
      </nav>

      <ActiveView />
    </div>
  );
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(() => loadConfig());
  const [loadError, setLoadError] = useState<string | null>(null);

  const handleDone = useCallback((cfg: AppConfig) => {
    saveConfig(cfg);
    setLoadError(null);
    setConfig(cfg);
  }, []);

  const handleDisconnect = useCallback(() => {
    clearConfig();
    setConfig(null);
  }, []);

  const handleError = useCallback((message: string) => {
    // League failed to load — drop back to setup with the error visible.
    setLoadError(message);
    setConfig(null);
  }, []);

  if (!config) return <Setup onDone={handleDone} initialError={loadError} />;

  return (
    <AppDataProvider config={config} onError={handleError}>
      <Shell onDisconnect={handleDisconnect} />
    </AppDataProvider>
  );
}
