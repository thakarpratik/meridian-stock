/**
 * Swing dip buys: a sharp one- or two-day drop in a stock that is trending up.
 *
 * Rules, all on the last completed daily close:
 * - RSI(2) under 10.
 * - Uptrend: close above the 50-day, 50-day above the 200-day, 200-day rising
 *   over the last 20 sessions.
 * - Price at least $10 and at least $100 million average daily dollar volume.
 * - SPY closed at or above its 20-day average. Otherwise no dip buys.
 *
 * Buy at the next session's open, sell at the close of the 10th session
 * (the buy day counts as the first). At most 10 positions, deepest dips first.
 *
 * Backtest (Sep 2022 – Nov 2026, today's universe, 0.1% costs): +0.6–0.8% per
 * trade over random entries in both periods. As a 10-slot portfolio it earned
 * 6.2%/yr in 2022–2025 against SPY's 17.8%, and +17.7% in 2026 against +1%.
 */
import { addSessions, nextSession, nyDay } from "./calendar";
import type { Bar, DipBook, DipSignal } from "./types";

const RSI_MAX = 10;
const MIN_PRICE = 10;
const MIN_DOLLAR_VOL = 100_000_000;
export const DIP_HOLD_SESSIONS = 10;
export const DIP_SLOTS = 10;

function rsi(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    gain += Math.max(diff, 0) / period;
    loss += Math.max(-diff, 0) / period;
  }
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    gain = (gain * (period - 1) + Math.max(diff, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

function mean(values: number[], end: number, n: number): number | null {
  if (end - n + 1 < 0) return null;
  let sum = 0;
  for (let i = end - n + 1; i <= end; i++) sum += values[i]!;
  return sum / n;
}

/** `charts` hold completed daily bars only. */
export function findDips(
  charts: Array<{ symbol: string; name: string; bars: Bar[] }>,
  spyBars: Bar[],
): DipBook {
  const empty = (line: string): DipBook => ({
    allowed: false,
    line,
    signalDay: null,
    buyDay: null,
    sellDay: null,
    signals: [],
  });
  if (spyBars.length < 21) return empty("SPY could not be read. No dip buys until it can.");

  const spyCloses = spyBars.map((bar) => bar.c);
  const spyEnd = spyCloses.length - 1;
  const spy20 = mean(spyCloses, spyEnd, 20)!;
  const spyClose = spyCloses[spyEnd]!;
  const signalDay = nyDay(spyBars[spyEnd]!.t);
  const buyDay = nextSession(signalDay);
  const sellDay = addSessions(buyDay, DIP_HOLD_SESSIONS - 1);
  const allowed = spyClose >= spy20;

  const signals: DipSignal[] = [];
  for (const chart of charts) {
    const bars = chart.bars;
    if (bars.length < 221) continue;
    const end = bars.length - 1;
    if (nyDay(bars[end]!.t) !== signalDay) continue;
    const closes = bars.map((bar) => bar.c);
    const close = closes[end]!;
    if (close < MIN_PRICE) continue;
    const dollarVol = bars.slice(-20).reduce((sum, bar) => sum + bar.c * bar.v, 0) / 20;
    if (dollarVol < MIN_DOLLAR_VOL) continue;
    const s50 = mean(closes, end, 50);
    const s200 = mean(closes, end, 200);
    const s200Prior = mean(closes, end - 20, 200);
    if (s50 == null || s200 == null || s200Prior == null) continue;
    if (!(close > s50 && s50 > s200 && s200 > s200Prior)) continue;
    const r2 = rsi(closes.slice(-120), 2);
    if (r2 == null || r2 >= RSI_MAX) continue;
    const drop2 = (close / closes[end - 2]! - 1) * 100;
    signals.push({
      symbol: chart.symbol,
      name: chart.name,
      close: Math.round(close * 100) / 100,
      rsi2: Math.round(r2 * 10) / 10,
      drop2Pct: Math.round(drop2 * 10) / 10,
      dollarVolM: Math.round(dollarVol / 1_000_000),
    });
  }
  signals.sort((a, b) => a.rsi2 - b.rsi2);

  const line = allowed
    ? `SPY closed at or above its 20-day ($${spy20.toFixed(0)}). Dip buys are on.`
    : `SPY closed under its 20-day ($${spy20.toFixed(0)}). No dip buys until it closes back above.`;
  return { allowed, line, signalDay, buyDay, sellDay, signals };
}
