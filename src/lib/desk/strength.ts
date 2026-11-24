/**
 * Strength picks: the 10 stocks with the biggest 12-month gain, skipping the
 * most recent month ("12-1 momentum"). Rebalanced weekly: on the first
 * trading day of each week, buy what entered the top 10 and sell what left.
 *
 * Eligible: $10+ and $100M+ average daily dollar volume. No market filter: in
 * the backtest the SPY 20-day filter hurt this strategy.
 *
 * Backtest (Dec 2022 – Nov 2026, today's universe, next-day trading, 0.1%
 * costs, median of 5 start days): 33.5%/yr in 2022–2025 against SPY's 18.3%,
 * and +16% in 2026 against +1%. Worst drop about −41% against SPY's −19%.
 * Today's universe makes momentum look better than it was.
 */
import { nyDay } from "./calendar";
import type { Bar, StrengthBook, StrengthPick } from "./types";

export const STRENGTH_COUNT = 10;
const MIN_PRICE = 10;
const MIN_DOLLAR_VOL = 100_000_000;
const LOOKBACK = 252;
const SKIP = 21;

const SECTOR_ALIASES: Record<string, string> = {
  "Information Technology": "Technology",
  Finance: "Financials",
  Telecommunications: "Communication Services",
  "Basic Materials": "Materials",
};

export function sectorName(raw: string): string {
  const name = raw.trim();
  return SECTOR_ALIASES[name] ?? (name || "Other");
}

/** `charts` hold completed daily bars only (about a year of them). */
export function rankStrength(
  charts: Array<{ symbol: string; name: string; sector: string; bars: Bar[] }>,
): StrengthBook {
  const scored: StrengthPick[] = [];
  let asOfDay: string | null = null;
  for (const chart of charts) {
    const bars = chart.bars;
    if (bars.length < 230) continue;
    const end = bars.length - 1;
    const close = bars[end]!.c;
    if (close < MIN_PRICE) continue;
    const dollarVol = bars.slice(-20).reduce((sum, bar) => sum + bar.c * bar.v, 0) / 20;
    if (dollarVol < MIN_DOLLAR_VOL) continue;
    const from = bars[Math.max(0, end - LOOKBACK)]!.c;
    const skipTo = bars[end - SKIP]!.c;
    if (!(from > 0)) continue;
    const day = nyDay(bars[end]!.t);
    if (!asOfDay || day > asOfDay) asOfDay = day;
    scored.push({
      symbol: chart.symbol,
      name: chart.name,
      sector: sectorName(chart.sector),
      close: Math.round(close * 100) / 100,
      gain12m1Pct: Math.round((skipTo / from - 1) * 1000) / 10,
      gain1mPct: Math.round((close / skipTo - 1) * 1000) / 10,
      dollarVolM: Math.round(dollarVol / 1_000_000),
    });
  }
  // Only names whose last bar is the latest day, so a stale chart cannot rank.
  const fresh = scored.filter((pick) => {
    const chart = charts.find((c) => c.symbol === pick.symbol)!;
    return nyDay(chart.bars[chart.bars.length - 1]!.t) === asOfDay;
  });
  fresh.sort((a, b) => b.gain12m1Pct - a.gain12m1Pct);
  return { asOfDay, picks: fresh.slice(0, STRENGTH_COUNT), next: fresh.slice(STRENGTH_COUNT, STRENGTH_COUNT + 5) };
}
