import type { Bar, Plan, Stance } from "./types";

const MIN_CAP = 300_000_000;
const MIN_PRICE = 10;
const MIN_DOLLAR_VOL = 8_000_000;
const MIN_RISK = 0.015;
const MAX_RISK = 0.09;
const MIN_RR = 1.8;

export type AnalyzeInput = {
  symbol: string;
  name: string;
  industry: string;
  marketCap: number;
  pe: number | null;
  changePct: number;
  bars: Bar[];
  fiftyTwoWeekHigh: number;
  fiftyTwoWeekLow: number;
  /** Regular-session price. Levels stay on the completed bars; this only marks the zone. */
  livePrice?: number;
};

export type AnalyzeResult =
  | { ok: true; plan: Plan }
  | { ok: false; symbol: string; name: string; reason: string };

function roundPx(n: number): number {
  return Math.round(n * 100) / 100;
}

function sma(values: number[], period: number, end: number): number | null {
  const start = end - period + 1;
  if (start < 0) return null;
  let sum = 0;
  for (let i = start; i <= end; i++) sum += values[i]!;
  return sum / period;
}

function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function atr(bars: Bar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i]!;
    const prev = bars[i - 1]!.c;
    trs.push(Math.max(bar.h - bar.l, Math.abs(bar.h - prev), Math.abs(bar.l - prev)));
  }
  let avg = 0;
  for (let i = 0; i < period; i++) avg += trs[i]!;
  avg /= period;
  for (let i = period; i < trs.length; i++) {
    avg = (avg * (period - 1) + trs[i]!) / period;
  }
  return avg;
}

function pct(from: number, to: number): number {
  return ((to - from) / from) * 100;
}

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function analyze(input: AnalyzeInput): AnalyzeResult {
  const { symbol, name, bars } = input;
  const fail = (reason: string): AnalyzeResult => ({ ok: false, symbol, name, reason });

  if (input.marketCap < MIN_CAP) {
    return fail("Market cap is under $300 million. Micro-caps stay off the desk.");
  }
  if (bars.length < 210) {
    return fail("Not enough clean daily history to judge the trend.");
  }

  const last = bars.length - 1;
  const price = bars[last]!.c;
  if (price < MIN_PRICE) return fail("Price is under $10. Penny stocks stay off the desk.");

  const closes = bars.map((bar) => bar.c);
  const lows = bars.map((bar) => bar.l);
  const yearLow = Math.min(...lows.slice(-220));
  if (yearLow < 5) {
    return fail("It traded under $5 in the past year. That penny past stays off the desk.");
  }

  const vol20 =
    bars.slice(-20).reduce((sum, bar) => sum + bar.v, 0) / Math.min(20, bars.length);
  if (vol20 * price < MIN_DOLLAR_VOL) {
    return fail("Average dollar volume is under $8 million. Too thin — the kind of tape pumps live on.");
  }

  const ret10 = pct(closes[last - 10]!, price);
  if (ret10 > 80) {
    return fail("Up more than 80% in ten sessions. Parabolic names are left out, even above $300 million.");
  }

  let spike = false;
  for (let i = Math.max(1, last - 40); i <= last; i++) {
    const day = pct(closes[i - 1]!, closes[i]!);
    if (day > 35 && input.marketCap < 40_000_000_000) spike = true;
  }
  if (spike) {
    return fail("A single-day jump over 35% on a sub-$40 billion name. Treated as an event spike, not a setup.");
  }

  const s20 = sma(closes, 20, last);
  const s50 = sma(closes, 50, last);
  const s200 = sma(closes, 200, last);
  const s200Prior = sma(closes, 200, last - 20);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(bars, 14);
  if (
    s20 == null ||
    s50 == null ||
    s200 == null ||
    s200Prior == null ||
    rsi14 == null ||
    atr14 == null ||
    atr14 <= 0
  ) {
    return fail("Indicators could not be built from the daily bars.");
  }

  const prior = bars.slice(last - 12, last);
  const swingLow = Math.min(...prior.map((bar) => bar.l));
  const low5 = Math.min(...bars.slice(last - 5, last).map((bar) => bar.l));
  const low8 = Math.min(...bars.slice(last - 8, last).map((bar) => bar.l));
  const twentyHigh = Math.max(...bars.slice(last - 20, last).map((bar) => bar.h));

  const up = price > s50 && s50 > s200 && s200 > s200Prior;
  const down = price < s200 && s50 <= s200;
  const trend: Plan["trend"] = up ? "up" : down ? "down" : "mixed";
  const hotPump = pct(closes[last - 20]!, price) > 50 && rsi14 > 80;
  if (hotPump) {
    return fail("A 20-day surge with RSI over 80. That is a chase, not a hold.");
  }

  const live = input.livePrice != null && input.livePrice > 0 ? input.livePrice : price;
  const spark = bars.slice(-140).map((bar) => ({ t: bar.t, c: roundPx(bar.c) }));
  const recentRange = bars.slice(-5).reduce((sum, bar) => sum + (bar.h - bar.l), 0) / 5;
  const atrPct = Math.round((atr14 / price) * 1000) / 10;
  const capTier: Plan["capTier"] =
    input.marketCap < 2_000_000_000 ? "small" : input.marketCap < 10_000_000_000 ? "mid" : "large";
  const coiled =
    recentRange < atr14 * 0.7 && price >= twentyHigh * 0.98 && atrPct >= 1.4 && atrPct < 3.5;
  const move: Plan["move"] = atrPct >= 3.5 ? "wide" : coiled ? "coiled" : "steady";
  const dayRange = money(atr14);
  const moveNote =
    move === "wide"
      ? `A typical day already travels about ${atrPct}% (${dayRange}). That is a large move. Size it from invalidation, not from the excitement.`
      : move === "coiled"
        ? `The last five sessions are tight and price is pressed against the 20-day high. A coil like this often releases into a larger move than the quiet days suggest.`
        : `Daily range is ordinary, about ${atrPct}%. Do not expect a violent move.`;

  const base = {
    symbol,
    name,
    industry: input.industry,
    price: roundPx(live),
    changePct: Math.round(input.changePct * 100) / 100,
    marketCap: input.marketCap,
    capTier,
    pe: input.pe,
    rsi: Math.round(rsi14),
    trend,
    sma20: roundPx(s20),
    sma50: roundPx(s50),
    sma200: roundPx(s200),
    atrPct,
    move,
    moveNote,
    spark,
  };

  if (!up) {
    const invalidation = roundPx(down ? Math.min(swingLow, s200) : swingLow);
    const why = down
      ? `${symbol} is under its 200-day average ($${roundPx(s200)}) and the 50-day is not above it. That is a downtrend. There is no long trigger.`
      : `${symbol} is not in a clean uptrend. Price, the 50-day, and the 200-day are not stacked. No buy until they are.`;
    const plan: Plan = {
      ...base,
      stance: "pass",
      why,
      location: down ? "Below the 200-day." : "Trend is mixed.",
      trigger: null,
      invalidation,
      target: null,
      holdTitle: "Do not hold this swing",
      holdDetail: `Pass. Do not buy. If you already own it, this swing plan says exit — especially on a close under ${money(invalidation)}. That is not a view on a multi-year investment.`,
      riskPct: null,
      rr: null,
      distancePct: null,
    };
    return { ok: true, plan };
  }

  // One entry: a pullback to the 20-day, or to the 50-day if the 20-day is already lost.
  // The level is the last completed close. It does not move during the session.
  const deep = price < s20 * 0.995;
  const anchor = deep ? "50-day" : "20-day";
  const trigger = roundPx(deep ? s50 : s20);
  const zoneHigh = roundPx(trigger * 1.015);
  const stop = chooseStop(trigger, [low5, low8, swingLow, s50, trigger - atr14 * 1.5, trigger - atr14 * 2]);
  if (stop == null) {
    const below = [low5, low8, swingLow, s50].filter((level) => level < trigger);
    const nearest = below.length ? Math.max(...below) : trigger * 0.95;
    const nearestRisk = ((trigger - nearest) / trigger) * 100;
    return {
      ok: true,
      plan: passRisk(
        base,
        `No invalidation sits in the 1.5–9% band under the ${anchor} at ${money(trigger)}. The nearest low is about ${nearestRisk.toFixed(1)}% away. Pass.`,
        roundPx(nearest),
      ),
    };
  }

  const invalidation = roundPx(stop);
  const riskDollars = trigger - invalidation;
  const riskFrac = riskDollars / trigger;
  let target = trigger + 2 * riskDollars;
  const hi = input.fiftyTwoWeekHigh;
  if (hi > trigger + 1.5 * riskDollars && hi < trigger + 2.6 * riskDollars) target = hi;
  if (twentyHigh > trigger + 1.5 * riskDollars && twentyHigh < target) target = twentyHigh;
  target = roundPx(target);
  if (!(target > trigger)) {
    return { ok: true, plan: passRisk(base, "There is no target far enough above the pullback. Pass.", invalidation) };
  }
  const rr = (target - trigger) / riskDollars;
  if (rr < MIN_RR) {
    return {
      ok: true,
      plan: passRisk(
        base,
        `Reward is only ${rr.toFixed(1)} times the risk to ${money(invalidation)}. The desk wants at least 1.8. Pass.`,
        invalidation,
      ),
    };
  }

  const trendLine = `${symbol} is in an uptrend: the last close is above a 50-day ($${roundPx(s50)}) that sits above a rising 200-day ($${roundPx(s200)}). RSI is ${Math.round(rsi14)}.`;
  const inZone = live <= zoneHigh && live >= trigger * 0.995;
  let stance: Stance;
  let location: string;
  let holdTitle: string;
  let holdDetail: string;
  let why: string;

  if (inZone) {
    stance = "buy";
    location = `Pullback is here. Enter at the ${anchor} ${money(trigger)}, and do not pay above ${money(zoneHigh)}.`;
    holdTitle = "Enter the pullback";
    holdDetail = `Buy only from ${money(trigger)} to ${money(zoneHigh)}. Hold while daily closes stay above ${money(invalidation)}. Sell at ${money(target)}. The entry was set at the last close and does not move today. Do not average down.`;
    why = `${trendLine} The buy is a pullback to the ${anchor}, not a breakout. Live price is in that zone.`;
  } else if (live > zoneHigh) {
    stance = "wait";
    location = `Pullback entry is the ${anchor} at ${money(trigger)}, ${Math.abs(pct(trigger, live)).toFixed(1)}% under the live price. Do not chase.`;
    holdTitle = "Wait for the pullback";
    holdDetail = `Do not buy this price. The only entry is ${money(trigger)} to ${money(zoneHigh)}. That level is locked to the last close for the rest of the session. If you already hold shares, keep them toward ${money(target)} only while closes stay above ${money(invalidation)}. Do not add up here.`;
    why = `${trendLine} It has not pulled back to the ${anchor} at ${money(trigger)}. Buying the live price is a chase.`;
  } else {
    stance = "wait";
    location = `Live price is under the ${anchor} at ${money(trigger)}. Do not catch the dip. Enter only back inside ${money(trigger)} to ${money(zoneHigh)}.`;
    holdTitle = "Wait for the pullback to hold";
    holdDetail = `Do not buy under ${money(trigger)}. The entry is back at the ${anchor}. If you already hold shares, invalidation is ${money(invalidation)} and the target is ${money(target)}.`;
    why = `${trendLine} Price slipped through the ${anchor}. The plan does not catch a falling pullback.`;
  }

  if (live <= invalidation) {
    stance = "pass";
    location = `Price is already under invalidation at ${money(invalidation)}.`;
    holdTitle = "Do not hold this swing";
    holdDetail = `The stop under the ${anchor} is ${money(invalidation)}, and the last price is through it. Do not buy the pullback. If you hold shares, the swing is over — do not average down.`;
    why = `${trendLine} That pullback is not usable today: price has already lost ${money(invalidation)}.`;
  } else if (target <= live) {
    stance = "pass";
    location = "The measured target is not above today's price.";
    holdTitle = "Do not start a new swing";
    holdDetail = `The target for a pullback at ${money(trigger)} is ${money(target)}, which price has already cleared. Take nothing new. If you hold it, the swing target is behind you.`;
    why = `${trendLine} A fresh long at ${money(trigger)} would be aiming at ${money(target)}, and the stock is already there. Pass.`;
  }

  if (stance === "buy" && move === "steady") {
    stance = "wait";
    location = `Pullback is at ${money(trigger)}, but a typical day is only ${atrPct}%. Too quiet to buy.`;
    holdTitle = "Not enough movement";
    holdDetail = `This desk buys a pullback only when a typical day is at least 3.5%, or price is coiled against the 20-day high. This one is ${atrPct}%. Do not buy it for a move. If you already hold it, invalidation is still ${money(invalidation)} and the target is ${money(target)}.`;
    why = `${trendLine} The ${anchor} is tagged, but the range is ordinary. Quiet stocks are not buys.`;
  }

  return {
    ok: true,
    plan: {
      ...base,
      stance,
      why,
      location,
      trigger,
      invalidation,
      target,
      holdTitle,
      holdDetail,
      riskPct: Math.round(riskFrac * 1000) / 10,
      rr: Math.round(rr * 10) / 10,
      distancePct: Math.round(pct(price, trigger) * 10) / 10,
    },
  };
}

function chooseStop(entry: number, candidates: number[]): number | null {
  const viable = candidates
    .filter((stop) => stop > 0 && stop < entry)
    .map((stop) => ({ stop, risk: (entry - stop) / entry }))
    .filter((item) => item.risk >= MIN_RISK && item.risk <= MAX_RISK);
  if (viable.length === 0) return null;
  viable.sort((a, b) => Math.abs(a.risk - 0.04) - Math.abs(b.risk - 0.04));
  return viable[0]!.stop;
}

function passRisk(
  base: Omit<
    Plan,
    | "stance"
    | "why"
    | "location"
    | "trigger"
    | "invalidation"
    | "target"
    | "holdTitle"
    | "holdDetail"
    | "riskPct"
    | "rr"
    | "distancePct"
  >,
  why: string,
  invalidation: number,
): Plan {
  return {
    ...base,
    stance: "pass",
    why,
    location: "Uptrend, but the levels do not pay.",
    trigger: null,
    invalidation,
    target: null,
    holdTitle: "Do not hold this swing",
    holdDetail: `No entry. If you already own it, invalidation is ${money(invalidation)} — a close through that line ends the swing. Do not average down.`,
    riskPct: null,
    rr: null,
    distancePct: null,
  };
}
