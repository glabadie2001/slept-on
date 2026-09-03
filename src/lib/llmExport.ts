// Self-contained markdown of the draft results for pasting into an LLM:
// league format, every team's roster (pick, consensus rank, Δ, bye), the
// strength ranking from the review, and the full pick-by-pick list.
import type { DraftReview, ReviewPick } from "./draftReview";
import type { SleeperDraft, SleeperLeague } from "../types";

export interface LlmExportInput {
  league: SleeperLeague;
  draft: SleeperDraft | null;
  mode: string;
  myRosterId: number | null;
  totalPicks: number;
  review: DraftReview;
  teamName: (rosterId: number | null) => string;
  byeOf: (playerId: string) => number | null;
  guideNames: string[];
}

function scoringSummary(s: Record<string, number>): string {
  const parts: string[] = [];
  if (s.rec != null) parts.push(`${s.rec} PPR`);
  if (s.pass_td != null) parts.push(`${s.pass_td}pt pass TD`);
  if (s.bonus_rec_te) parts.push(`TE premium +${s.bonus_rec_te}`);
  if (s.pass_int != null) parts.push(`INT ${s.pass_int}`);
  if (s.fum_lost != null) parts.push(`fumble ${s.fum_lost}`);
  return parts.join(", ") || "standard";
}

function slotSummary(slots: string[]): string {
  const counts: Record<string, number> = {};
  for (const s of slots) counts[s] = (counts[s] ?? 0) + 1;
  return Object.entries(counts).map(([s, n]) => (n > 1 ? `${n}×${s}` : s)).join(", ");
}

const delta = (p: ReviewPick) => (p.consensus == null ? "unranked" : `#${p.consensus}, Δ ${p.delta! > 0 ? "+" : ""}${p.delta}`);

export function buildLlmExport(i: LlmExportInput): string {
  const L: string[] = [];
  const done = i.draft?.status === "complete";
  const picks = i.review.picks;
  L.push(`# Fantasy draft results — ${i.league.name} (${i.league.season})`);
  L.push("");
  L.push(
    done
      ? "Review this completed fantasy football draft. Grade every team, call out the best and worst picks, and tell me how my roster stacks up and what I should do on waivers or in trades. Consider byes, injuries, depth charts and playoff-week schedules — my tool only knows consensus rank."
      : "This draft is in progress. Review it so far: how every team is doing, what I should target with my remaining picks, and where the value will be. Consider byes, injuries, depth charts and playoff-week schedules — my tool only knows consensus rank.",
  );
  L.push("");
  L.push("## League");
  L.push(`- ${i.league.total_rosters} teams · ${i.mode} draft · ${i.draft?.type ?? "snake"} order · ${picks.length} of ${i.totalPicks} picks made${done ? " (complete)" : ""}`);
  L.push(`- Starting slots: ${slotSummary(i.league.roster_positions.filter((s) => s !== "BN" && s !== "IR" && s !== "TAXI"))}; bench ${i.league.roster_positions.filter((s) => s === "BN").length}`);
  L.push(`- Scoring: ${scoringSummary(i.league.scoring_settings)}`);
  if (i.guideNames.length) L.push(`- Consensus ranks below come from: ${i.guideNames.join("; ")}`);
  L.push("- Δ = pick number − consensus rank: positive means the player fell (value), negative means a reach.");
  L.push("");
  L.push(`## Teams ranked by ${i.mode === "rookie" ? "summed dynasty value" : "projected starting-lineup points"} of what they drafted`);
  i.review.teams.forEach((t, n) => {
    const mix = Object.entries(t.posMix).sort((a, b) => b[1] - a[1]).map(([p, c]) => `${c} ${p}`).join(", ");
    L.push(`${n + 1}. **${i.teamName(t.rosterId)}**${t.rosterId === i.myRosterId ? " (me)" : ""} — strength ${t.strength} · ${t.picks.length} picks (${mix || "—"}) · avg Δ ${t.avgDelta == null ? "—" : `${t.avgDelta > 0 ? "+" : ""}${t.avgDelta.toFixed(1)}`}${t.bestValue ? ` · best value ${t.bestValue.name} (+${t.bestValue.delta})` : ""}${t.biggestReach ? ` · biggest reach ${t.biggestReach.name} (${t.biggestReach.delta})` : ""}`);
  });
  L.push("");
  L.push("## Rosters");
  for (const t of i.review.teams) {
    L.push(`### ${i.teamName(t.rosterId)}${t.rosterId === i.myRosterId ? " (me)" : ""}`);
    const byPos = [...t.picks].sort((a, b) => (a.position ?? "").localeCompare(b.position ?? "") || a.pickNo - b.pickNo);
    for (const p of byPos) {
      const bye = i.byeOf(p.playerId);
      L.push(`- ${p.position ?? "?"} ${p.name} — R${p.round}.${String(p.slot).padStart(2, "0")} (pick ${p.pickNo}) · ${delta(p)}${bye != null ? ` · bye ${bye}` : ""}${p.keeper ? " · keeper" : ""}`);
    }
    L.push("");
  }
  if (i.review.bestValues.length || i.review.biggestReaches.length) {
    L.push("## League-wide");
    if (i.review.bestValues.length) L.push(`- Best values: ${i.review.bestValues.map((p) => `${p.name} (+${p.delta}, ${i.teamName(p.rosterId)})`).join("; ")}`);
    if (i.review.biggestReaches.length) L.push(`- Biggest reaches: ${i.review.biggestReaches.map((p) => `${p.name} (${p.delta}, ${i.teamName(p.rosterId)})`).join("; ")}`);
    L.push("");
  }
  L.push("## Pick by pick");
  for (const p of picks) L.push(`${p.pickNo}. ${p.name} (${p.position ?? "?"}) → ${i.teamName(p.rosterId)} · ${delta(p)}${p.keeper ? " · keeper" : ""}`);
  L.push("");
  return L.join("\n");
}
