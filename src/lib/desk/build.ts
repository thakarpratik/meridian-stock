/** Builds the desk and the day book from Yahoo prices. Plain Node, no server framework, so a scheduled job can run it too. */

import { analyze } from "./analyze";
import { checkHeadlines } from "./news";
import { analyzeSession, spySessionLine } from "./session";
import type { Bar, DayBook, DayTrade, Desk, Plan, Reject } from "./types";
import { BOOK } from "./universe";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const TTL_MS = 10 * 60 * 1000;

type ChartPack = {
  bars: Bar[];
  price: number;
  changePct: number;
  fiftyTwoWeekHigh: number;
  fiftyTwoWeekLow: number;
  name: string;
};

let cache: { at: number; desk: Desk } | null = null;
let inflight: Promise<Desk> | null = null;
let dayCache: { at: number; book: DayBook } | null = null;
let dayInflight: Promise<DayBook> | null = null;
const DAY_TTL_MS = 90 * 1000;

async function fetchChart(symbol: string): Promise<ChartPack | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d&includePrePost=false&events=div%7Csplit`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": UA },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const json = (await response.json()) as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: { quote?: Array<Record<string, Array<number | null>>> };
          meta?: {
            regularMarketPrice?: number;
            regularMarketChangePercent?: number;
            fiftyTwoWeekHigh?: number;
            fiftyTwoWeekLow?: number;
            longName?: string;
            shortName?: string;
            instrumentType?: string;
          };
        }>;
      };
    };
    const result = json.chart?.result?.[0];
    if (!result?.timestamp || !result.indicators?.quote?.[0]) return null;
    const quote = result.indicators.quote[0];
    const meta = result.meta ?? {};
    const bars: Bar[] = [];
    for (let i = 0; i < result.timestamp.length; i++) {
      const o = quote.open?.[i];
      const h = quote.high?.[i];
      const l = quote.low?.[i];
      let c = quote.close?.[i];
      const v = quote.volume?.[i];
      if (
        (c == null || c <= 0) &&
        i === result.timestamp.length - 1 &&
        meta.regularMarketPrice &&
        meta.regularMarketPrice > 0
      ) {
        c = meta.regularMarketPrice;
      }
      if (o == null || h == null || l == null || c == null || v == null || c <= 0) continue;
      bars.push({ t: result.timestamp[i]! * 1000, o, h, l, c, v });
    }
    if (bars.length < 50) return null;
    if (meta.instrumentType && meta.instrumentType !== "EQUITY" && symbol !== "SPY") return null;
    const live = meta.regularMarketPrice;
    return {
      bars,
      price: live && live > 0 ? live : bars[bars.length - 1]!.c,
      changePct: meta.regularMarketChangePercent ?? 0,
      fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? Math.max(...bars.map((bar) => bar.h)),
      fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? Math.min(...bars.map((bar) => bar.l)),
      name: meta.longName || meta.shortName || symbol,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

type LiveQuote = { price: number; changePct: number; fiftyTwoWeekHigh?: number; fiftyTwoWeekLow?: number };

/** Live prices for many symbols, 20 per request, from Yahoo's spark endpoint. */
async function fetchLiveQuotes(symbols: string[]): Promise<Map<string, LiveQuote>> {
  const out = new Map<string, LiveQuote>();
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += 20) chunks.push(symbols.slice(i, i + 20));
  await mapPool(chunks, 6, async (chunk) => {
    const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${chunk.map(encodeURIComponent).join(",")}&range=1d&interval=5m`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": UA },
        signal: controller.signal,
      });
      if (!response.ok) return;
      const json = (await response.json()) as {
        spark?: {
          result?: Array<{
            symbol: string;
            response?: Array<{
              meta?: {
                regularMarketPrice?: number;
                previousClose?: number;
                chartPreviousClose?: number;
                fiftyTwoWeekHigh?: number;
                fiftyTwoWeekLow?: number;
              };
            }>;
          }>;
        };
      };
      for (const item of json.spark?.result ?? []) {
        const meta = item.response?.[0]?.meta;
        const price = meta?.regularMarketPrice;
        if (!meta || !price || price <= 0) continue;
        const prev = meta.previousClose ?? meta.chartPreviousClose;
        out.set(item.symbol, {
          price,
          changePct: prev ? (price / prev - 1) * 100 : 0,
          fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
          fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
        });
      }
    } catch {
      // Symbols missing here fall back to a full chart read.
    } finally {
      clearTimeout(timer);
    }
  });
  return out;
}

/**
 * Daily charts kept for the rest of the session. Swing levels are locked to the
 * last close, so during the session only the live price changes; the alert job
 * runs every two minutes and refreshes prices in bulk instead of re-reading
 * 340 one-year charts.
 */
const dailyCache = new Map<string, { key: string; chart: ChartPack }>();

function dailyKey(now: Date): string {
  const clock = nyClock(now);
  return `${clock.ymd}|${clock.mins >= 16 * 60 ? "closed" : "open"}`;
}

async function loadDailyCharts(symbols: string[], now: Date, sessionOpen: boolean): Promise<Map<string, ChartPack | null>> {
  const key = dailyKey(now);
  const out = new Map<string, ChartPack | null>();
  const cached = symbols.filter((symbol) => dailyCache.get(symbol)?.key === key);
  const live = sessionOpen && cached.length ? await fetchLiveQuotes(cached) : new Map<string, LiveQuote>();
  const missing: string[] = [];
  for (const symbol of symbols) {
    const hit = dailyCache.get(symbol);
    if (hit?.key !== key) {
      missing.push(symbol);
      continue;
    }
    if (!sessionOpen) {
      out.set(symbol, hit.chart);
      continue;
    }
    const quote = live.get(symbol);
    if (!quote) {
      missing.push(symbol);
      continue;
    }
    out.set(symbol, {
      ...hit.chart,
      price: quote.price,
      changePct: quote.changePct,
      fiftyTwoWeekHigh: Math.max(quote.fiftyTwoWeekHigh ?? 0, hit.chart.fiftyTwoWeekHigh, quote.price),
      fiftyTwoWeekLow: Math.min(quote.fiftyTwoWeekLow ?? Infinity, hit.chart.fiftyTwoWeekLow, quote.price),
    });
  }
  const fresh = await mapPool(missing, 14, async (symbol) => ({ symbol, chart: await fetchChart(symbol) }));
  for (const { symbol, chart } of fresh) {
    out.set(symbol, chart);
    if (chart) dailyCache.set(symbol, { key, chart });
  }
  return out;
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

export async function fetchIntraday(symbol: string): Promise<{ name: string; bars: Bar[] } | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=5m&includePrePost=false`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": UA },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const json = (await response.json()) as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: { quote?: Array<Record<string, Array<number | null>>> };
          meta?: {
            regularMarketPrice?: number;
            longName?: string;
            shortName?: string;
            instrumentType?: string;
          };
        }>;
      };
    };
    const result = json.chart?.result?.[0];
    if (!result?.timestamp || !result.indicators?.quote?.[0]) return null;
    const quote = result.indicators.quote[0];
    const bars: Bar[] = [];
    for (let i = 0; i < result.timestamp.length; i++) {
      const o = quote.open?.[i];
      const h = quote.high?.[i];
      const l = quote.low?.[i];
      const c = quote.close?.[i];
      const v = quote.volume?.[i];
      if (o == null || h == null || l == null || c == null || v == null || c <= 0) continue;
      bars.push({ t: result.timestamp[i]! * 1000, o, h, l, c, v });
    }
    if (bars.length < 20) return null;
    const meta = result.meta ?? {};
    if (meta.instrumentType && meta.instrumentType !== "EQUITY" && symbol !== "SPY") return null;
    const live = meta.regularMarketPrice;
    if (live && live > 0) {
      const last = bars[bars.length - 1]!;
      if (Math.abs(last.c - live) / live > 0.002) {
        bars[bars.length - 1] = {
          ...last,
          c: live,
          h: Math.max(last.h, live),
          l: Math.min(last.l, live),
        };
      }
    }
    return { name: meta.longName || meta.shortName || symbol, bars };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sortTrades(trades: DayTrade[]): DayTrade[] {
  const rank = { buy: 0, wait: 1, pass: 2 };
  const travelRank = (trade: DayTrade) => (trade.travel === "quiet" ? 1 : 0);
  return [...trades].sort((a, b) => {
    if (rank[a.stance] !== rank[b.stance]) return rank[a.stance] - rank[b.stance];
    if (travelRank(a) !== travelRank(b)) return travelRank(a) - travelRank(b);
    return (b.typicalPct ?? 0) - (a.typicalPct ?? 0) || b.rvol - a.rvol;
  });
}

async function buildDayBook(): Promise<DayBook> {
  const symbols = [...BOOK.map((entry) => entry.symbol), "SPY"];
  const charts = await mapPool(symbols, 12, async (symbol) => ({
    symbol,
    chart: await fetchIntraday(symbol),
  }));
  const bySymbol = new Map(charts.map((item) => [item.symbol, item.chart]));
  const now = new Date();
  const spy = bySymbol.get("SPY");
  const sessionNote = spy
    ? spySessionLine(spy.bars, now)
    : "SPY's session could not be read. Treat every long with extra doubt.";

  const desk = await getDesk(false);
  const planBy = new Map(desk.plans.map((plan) => [plan.symbol, plan]));
  const trades: DayTrade[] = [];
  for (const entry of BOOK) {
    const chart = bySymbol.get(entry.symbol);
    if (!chart) continue;
    const plan = planBy.get(entry.symbol);
    const trade = analyzeSession({
      symbol: entry.symbol,
      name: chart.name,
      bars: chart.bars,
      now,
      atrPct: plan?.atrPct ?? null,
      coiled: plan?.move === "coiled",
    });
    if (!trade) continue;
    if (plan?.newsBlock && trade.stance === "buy") {
      trade.stance = "wait";
      trade.location = plan.newsNote ?? "A headline blocks a new long.";
      trade.flatTitle = "News blocks the buy";
      trade.why = plan.newsNote ?? trade.why;
    }
    trades.push(trade);
  }
  if (trades.length < 12) {
    throw new Error("Not enough intraday prices to build the day book. Try again.");
  }
  const sorted = sortTrades(trades);
  const movers = sorted.filter((trade) => trade.travel !== "quiet");
  const buys = movers.filter((trade) => trade.stance === "buy").length;
  const waits = movers.filter((trade) => trade.stance === "wait").length;
  const buyWord = buys === 1 ? "mover day buy is" : "mover day buys are";
  const waitWord =
    waits === 1 ? "name that can travel is a wait" : "names that can travel are waits";
  return {
    asOf: now.toISOString(),
    sessionNote,
    summary: `${buys} ${buyWord} armed. ${waits} ${waitWord}. Flat by 15:50 ET.`,
    trades: sorted,
  };
}

export async function getDayBook(force: boolean): Promise<DayBook> {
  if (!force && dayCache && Date.now() - dayCache.at < DAY_TTL_MS) return dayCache.book;
  if (!force && dayInflight) return dayInflight;
  const run = buildDayBook()
    .then((book) => {
      dayCache = { at: Date.now(), book };
      return book;
    })
    .finally(() => {
      dayInflight = null;
    });
  dayInflight = run;
  return run;
}

function sessionLabel(now: Date): string {
  const clock = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => clock.find((part) => part.type === type)?.value ?? "";
  const mins = Number(get("hour")) * 60 + Number(get("minute"));
  const day = get("weekday");
  const weekend = day === "Sat" || day === "Sun";
  let session = "Market closed";
  if (!weekend && mins >= 4 * 60 && mins < 9 * 60 + 30) session = "Premarket";
  else if (!weekend && mins >= 9 * 60 + 30 && mins < 16 * 60) session = "Regular session";
  else if (!weekend && mins >= 16 * 60 && mins < 20 * 60) session = "After hours";
  const stamp = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(now);
  return `${stamp} · ${session}`;
}

function sortPlans(plans: Plan[]): Plan[] {
  const rank = { buy: 0, wait: 1, pass: 2 };
  const quiet = (plan: Plan) => (plan.move === "steady" ? 1 : 0);
  return [...plans].sort((a, b) => {
    if (rank[a.stance] !== rank[b.stance]) return rank[a.stance] - rank[b.stance];
    if (quiet(a) !== quiet(b)) return quiet(a) - quiet(b);
    if (a.stance === "buy" || a.move !== "steady")
      return b.atrPct - a.atrPct || (b.rr ?? 0) - (a.rr ?? 0);
    if (a.stance === "wait") {
      const key = (plan: Plan) => Math.abs(plan.distancePct ?? 99);
      return key(a) - key(b);
    }
    return b.marketCap - a.marketCap;
  });
}

function nyClock(now: Date): { ymd: string; mins: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const ymd = `${get("year")}-${get("month")}-${get("day")}`;
  return { ymd, mins: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** Drop today's unfinished daily bar so a tick cannot rewrite the swing plan. */
function completedDailyBars(bars: Bar[], now: Date): Bar[] {
  if (bars.length < 2) return bars;
  const today = nyClock(now);
  const last = nyClock(new Date(bars[bars.length - 1]!.t));
  if (last.ymd === today.ymd && today.mins < 16 * 60) return bars.slice(0, -1);
  return bars;
}

function inRegularSession(now: Date): boolean {
  const clock = nyClock(now);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(now);
  if (day === "Sat" || day === "Sun") return false;
  return clock.mins >= 9 * 60 + 30 && clock.mins < 16 * 60;
}

async function buildDesk(): Promise<Desk> {
  const symbols = [...BOOK.map((entry) => entry.symbol), "SPY"];
  const now = new Date();
  const sessionOpen = inRegularSession(now);
  const bySymbol = await loadDailyCharts(symbols, now, sessionOpen);

  const spy = bySymbol.get("SPY");
  let tape: Desk["tape"] = {
    price: 0,
    changePct: 0,
    above200: false,
    line: "SPY could not be read. Treat every long with extra doubt.",
  };
  const spyBars = spy ? completedDailyBars(spy.bars, now) : [];
  if (spy && spyBars.length > 200) {
    const closes = spyBars.map((bar) => bar.c);
    const end = closes.length - 1;
    let sum = 0;
    for (let i = end - 199; i <= end; i++) sum += closes[i]!;
    const sma200 = sum / 200;
    const above = spy.price > sma200;
    tape = {
      price: Math.round(spy.price * 100) / 100,
      changePct: Math.round(spy.changePct * 100) / 100,
      above200: above,
      line: above
        ? `SPY is above its 200-day ($${sma200.toFixed(0)}). Swing longs are allowed.`
        : `SPY is under its 200-day ($${sma200.toFixed(0)}). The tape is a headwind — demand a cleaner trigger.`,
    };
  }

  const plans: Plan[] = [];
  const rejected: Reject[] = [];
  const qualified: string[] = [];
  let charted = 0;

  for (const entry of BOOK) {
    const chart = bySymbol.get(entry.symbol);
    if (!chart) {
      rejected.push({
        symbol: entry.symbol,
        name: entry.symbol,
        reason: "Daily prices did not load. Left off until the next read.",
      });
      continue;
    }
    charted += 1;
    const marketCap = entry.shares * chart.price;
    if (marketCap >= 300_000_000 && chart.price >= 10) qualified.push(entry.symbol);
    const settled = completedDailyBars(chart.bars, now);
    const result = analyze({
      symbol: entry.symbol,
      name: chart.name,
      industry: (entry.industry || entry.sector).trim(),
      marketCap,
      pe: null,
      changePct: chart.changePct,
      bars: settled,
      fiftyTwoWeekHigh: chart.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: chart.fiftyTwoWeekLow,
      livePrice: sessionOpen ? chart.price : undefined,
    });
    if (!result.ok) {
      rejected.push({ symbol: entry.symbol, name: chart.name, reason: result.reason });
      continue;
    }
    plans.push(result.plan);
  }

  if (plans.length < 15) {
    throw new Error("Not enough prices came back to build the desk. Try refresh.");
  }

  const chartBuys = plans.filter((plan) => plan.stance === "buy" && plan.move !== "steady");
  await mapPool(chartBuys, 6, async (plan) => {
    const check = await checkHeadlines(plan.symbol, plan.name, now);
    plan.newsNote = check.note;
    plan.newsBlock = check.blocksBuy;
    if (!check.blocksBuy) return;
    plan.stance = "wait";
    plan.location = check.note;
    plan.holdTitle = "News blocks the buy";
    plan.holdDetail = `${check.note} The pullback level is still ${plan.trigger == null ? "unset" : `$${plan.trigger.toFixed(2)}`}. Do not buy it while this headline is the story.`;
    plan.why = check.note;
  });

  const sorted = sortPlans(plans);
  const movers = sorted.filter((plan) => plan.move !== "steady");
  const moverBuys = movers.filter((plan) => plan.stance === "buy").length;
  const moverWaits = movers.filter((plan) => plan.stance === "wait").length;
  const buyWord = moverBuys === 1 ? "pullback buy is" : "pullback buys are";
  const waitWord =
    moverWaits === 1
      ? "pullback is still above its entry"
      : "pullbacks are still above their entry";

  return {
    asOf: new Date().toISOString(),
    sessionLabel: sessionLabel(new Date()),
    summary: `${moverBuys} ${buyWord} in the pullback zone. ${moverWaits} ${waitWord}. Levels are locked to the last close.`,
    tape,
    scanned: BOOK.length,
    charted,
    removed: rejected.length,
    qualified,
    plans: sorted,
    rejected,
  };
}

/** `maxAgeMs` lets a caller that needs live zones (the alert job) accept less cache age. */
export async function getDesk(force: boolean, maxAgeMs = TTL_MS): Promise<Desk> {
  if (!force && cache && Date.now() - cache.at < maxAgeMs) return cache.desk;
  if (!force && inflight) return inflight;
  const run = buildDesk()
    .then((desk) => {
      cache = { at: Date.now(), desk };
      return desk;
    })
    .finally(() => {
      inflight = null;
    });
  inflight = run;
  return run;
}

/** Setups waiting for a bounce plus open positions with a stop. */
const MAX_WATCH = 40;
/** Buy zones are under 1% wide, so the alert job reads prices at most this old. */
const ALERT_MAX_AGE_MS = 60 * 1000;

export type AlertsPayload = {
  asOf: string;
  buys: Array<
    Pick<
      Plan,
      | "symbol"
      | "name"
      | "price"
      | "trigger"
      | "zoneHigh"
      | "invalidation"
      | "target"
      | "upsidePct"
      | "riskPct"
      | "rr"
      | "atrPct"
      | "location"
    >
  >;
  tape: Record<string, { price: number; bars: { t: number; h: number; l: number; c: number }[] }>;
};

/**
 * Armed swing buys for the scheduled alert job (scripts/buy-alerts.mjs). The
 * desk already demands the minimum upside before it calls a buy, so this only
 * filters and trims.
 *
 * `watch` adds 5-minute bars for setups the job is holding for a bounce. Those
 * have usually dropped under their trigger and left `buys`, so the job needs
 * their prices from here. Every buy gets bars too, so the job can tell whether
 * it is still falling when it arms.
 */
export async function buildAlerts(watch: string[], desk?: Desk): Promise<AlertsPayload> {
  const source = desk ?? (await getDesk(false, ALERT_MAX_AGE_MS));
  const buys = source.plans
    .filter((plan) => plan.stance === "buy" && plan.move !== "steady")
    .map((plan) => ({
      symbol: plan.symbol,
      name: plan.name,
      price: plan.price,
      trigger: plan.trigger,
      zoneHigh: plan.zoneHigh,
      invalidation: plan.invalidation,
      target: plan.target,
      upsidePct: plan.upsidePct,
      riskPct: plan.riskPct,
      rr: plan.rr,
      atrPct: plan.atrPct,
      location: plan.location,
    }));
  const known = new Set(BOOK.map((entry) => entry.symbol));
  const watched = watch
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => known.has(symbol))
    .slice(0, MAX_WATCH);
  const symbols = [...new Set([...buys.map((buy) => buy.symbol), ...watched])];
  const charts = await Promise.all(
    symbols.map(async (symbol) => [symbol, await fetchIntraday(symbol)] as const),
  );
  const tape: AlertsPayload["tape"] = {};
  for (const [symbol, chart] of charts) {
    if (!chart) continue;
    tape[symbol] = {
      price: chart.bars[chart.bars.length - 1]!.c,
      bars: chart.bars.map((bar) => ({ t: bar.t, h: bar.h, l: bar.l, c: bar.c })),
    };
  }
  return { asOf: source.asOf, buys, tape };
}
