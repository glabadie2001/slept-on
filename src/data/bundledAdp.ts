import type { GuideEntry } from "../lib/guides";

/**
 * Multi-platform ADP snapshots, kind "adp": where real drafters take players,
 * as opposed to what experts think they're worth. Written by `npm run scrape`
 * (scripts/scrape/*.mjs) — each scraper joins to Sleeper ids through the
 * DynastyProcess id map and fails loudly on layout changes rather than
 * emitting an empty board.
 *
 * Empty until the scrapers have been run from a machine that can reach the
 * sources (ESPN, NFFC, Underdog, DLF). The Draft tab hides the "ADP snapshots"
 * button while this is empty; Sleeper ADP is fetched live regardless.
 */

export interface BundledAdp {
  name: string;
  /** redraft ADP boards by scoring format; dynasty boards by QB format */
  format: "std" | "half_ppr" | "ppr" | "2qb" | "dynasty_1qb" | "dynasty_sf" | "rookie";
  scrapedAt: string;
  entries: GuideEntry[];
}

export const BUNDLED_ADP: BundledAdp[] = [];
