import { money } from "./format";
import type { Bar, DayTrade, Stance, Travel } from "./types";

const MIN_DAY_DOLLAR = 30_000_000;
const MIN_RISK = 0.0012;
const MAX_RISK = 0.012;
const CHASE = 0.0035;

export type SessionInput = {
  symbol: string;
  name: string;
  bars: Bar[];
  now: Date;
  atrPct?: number | null;
  coiled?: boolean;
};

type Et = { key: string; mins: number; weekday: string };

function etOf(ms: number): Et {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    key: `${get("year")}-${get("month")}-${get("day")}`,
    mins: Number(get("hour")) * 60 + Number(get("minute")),
    weekday: get("weekday"),
  };
}

function roundPx(n: number): number {
  return Math.round(n * 100) / 100;
}

function pickStop(entry: number, candidates: number[]): number | null {
  const viable = candidates
    .filter((stop) => stop > 0 && stop < entry)
    .map((stop) => ({ stop, risk: (entry - stop) / entry }))
    .filter((item) => item.risk >= MIN_RISK && item.risk <= MAX_RISK);
  if (viable.length === 0) return null;
  viable.sort((a, b) => Math.abs(a.risk - 0.0045) - Math.abs(b.risk - 0.0045));
  return viable[0]!.stop;
}

function vwapOf(bars: Bar[]): number {
  const vols = bars.map((bar) => bar.v).sort((a, b) => a - b);
  const median = vols[Math.floor(vols.length / 2)] || 1;
  const cap = median * 8;
  let pv = 0;
  let vol = 0;
  for (const bar of bars) {
    const weight = Math.min(bar.v, cap);
    pv += ((bar.h + bar.l + bar.c) / 3) * weight;
    vol += weight;
  }
  return vol > 0 ? pv / vol : bars[bars.length - 1]!.c;
}

function cappedVolume(bars: Bar[]): number {
  const vols = bars.map((bar) => bar.v).sort((a, b) => a - b);
  const median = vols[Math.floor(vols.length / 2)] || 1;
  const cap = median * 8;
  return bars.reduce((sum, bar) => sum + Math.min(bar.v, cap), 0);
}

export function analyzeSession(input: SessionInput): DayTrade | null {
  const { symbol, name, bars, now } = input;
  if (bars.length < 30) return null;

  const stamped = bars.map((bar) => ({ bar, et: etOf(bar.t) }));
  const regular = stamped.filter((item) => item.et.mins >= 9 * 60 + 30 && item.et.mins < 16 * 60);
  if (regular.length < 20) return null;

  const dates = [...new Set(regular.map((item) => item.et.key))];
  const nowEt = etOf(now.getTime());
  const todayKey = dates.includes(nowEt.key) ? nowEt.key : dates[dates.length - 1]!;
  const today = regular.filter((item) => item.et.key === todayKey).map((item) => item.bar);
  const priorDates = dates.filter((key) => key < todayKey).slice(-5);
  if (today.length < 4 || priorDates.length === 0) return null;

  const priorDays = priorDates.map((key) => regular.filter((item) => item.et.key === key).map((item) => item.bar));
  const dollar = priorDays.map((day) => {
    const last = day[day.length - 1]!.c;
    return day.reduce((sum, bar) => sum + bar.v, 0) * last;
  });
  const avgDollar = dollar.reduce((sum, value) => sum + value, 0) / dollar.length;
  const price = today[today.length - 1]!.c;
  if (price < 10 || avgDollar < MIN_DAY_DOLLAR) return null;

  const prior = priorDays[priorDays.length - 1]!;
  const prevClose = prior[prior.length - 1]!.c;
  const avgFullVol = priorDays.reduce((sum, day) => sum + day.reduce((inner, bar) => inner + bar.v, 0), 0) / priorDays.length;
  const weekend = nowEt.weekday === "Sat" || nowEt.weekday === "Sun";
  const clock = nowEt.key === todayKey ? nowEt.mins : 16 * 60;
  const elapsed = Math.min(390, Math.max(5, clock - (9 * 60 + 30)));
  const sessionOpen = !weekend && clock >= 9 * 60 + 30 && clock < 16 * 60;
  const forming = sessionOpen && clock < 10 * 60;
  const closed = !sessionOpen;
  const rvol = avgFullVol > 0 ? cappedVolume(today) / (avgFullVol * (elapsed / 390)) : 0;
  const vwap = vwapOf(today);
  const orBars = today.filter((bar) => {
    const mins = etOf(bar.t).mins;
    return mins >= 9 * 60 + 30 && mins < 10 * 60;
  });
  const spark = today.map((bar) => ({ t: bar.t, c: roundPx(bar.c) }));
  const changePct = Math.round(((price - prevClose) / prevClose) * 10000) / 100;
  const pace = Math.round(rvol * 10) / 10;
  const typicalPct =
    input.atrPct == null || !Number.isFinite(input.atrPct) ? null : Math.round(input.atrPct * 10) / 10;
  const todayHigh = Math.max(...today.map((bar) => bar.h));
  const todayLow = Math.min(...today.map((bar) => bar.l));
  const todayRangePct = ((todayHigh - todayLow) / price) * 100;
  const travel: Travel =
    typicalPct != null && typicalPct >= 3.5
      ? "wide"
      : input.coiled
        ? "coiled"
        : todayRangePct >= 2.2 && pace >= 1.2
          ? "hot"
          : "quiet";

  const shell = {
    symbol,
    name,
    price: roundPx(price),
    changePct,
    vwap: roundPx(vwap),
    rvol: pace,
    travel,
    typicalPct,
    spark,
  };

  if (forming || orBars.length < 4) {
    return {
      ...shell,
      stance: "wait",
      why: `${symbol} is ${price >= vwap ? "above" : "below"} VWAP (${money(roundPx(vwap))}). The opening range is not closed, so there is no day-trade trigger yet.`,
      location: "Opening range closes at 10:00 ET. Do not front-run it.",
      trigger: null,
      invalidation: null,
      target: null,
      flatTitle: "Do not enter yet",
      flatDetail: "Wait for the first 30 minutes. A long is only through that high, and only while price holds VWAP. Be flat by 15:50 ET. Do not hold overnight.",
      orHigh: null,
      orLow: null,
      riskPct: null,
      rr: null,
      rangeReady: false,
    };
  }

  const orHigh = Math.max(...orBars.map((bar) => bar.h));
  const orLow = Math.min(...orBars.map((bar) => bar.l));
  const flatAlways = "Be flat by 15:50 ET. Do not hold this overnight.";

  if (price < vwap) {
    return {
      ...shell,
      stance: "pass",
      why: `${symbol} is under session VWAP (${money(roundPx(vwap))}). The opening range is ${money(roundPx(orLow))}–${money(roundPx(orHigh))}. A long day trade is off.`,
      location: "Under VWAP. No long.",
      trigger: null,
      invalidation: roundPx(Math.min(orLow, vwap)),
      target: null,
      flatTitle: "Do not buy",
      flatDetail: `Longs need price above VWAP. If you are already in, losing VWAP ends it. ${flatAlways}`,
      orHigh: roundPx(orHigh),
      orLow: roundPx(orLow),
      riskPct: null,
      rr: null,
      rangeReady: true,
    };
  }

  const trigger = roundPx(orHigh);
  const chaseCap = orHigh * (1 + CHASE);
  const broke = price >= orHigh;
  const entry = broke && price <= chaseCap ? price : orHigh;
  const recentLow = Math.min(...today.slice(-6).map((bar) => bar.l));
  const stop = pickStop(entry, [orLow, vwap, recentLow]);
  if (stop == null) {
    return {
      ...shell,
      stance: "pass",
      why: `${symbol} is above VWAP, but neither the opening-range low (${money(roundPx(orLow))}) nor VWAP sits in the 0.12–1.2% risk band under ${money(roundPx(entry))}. No day-trade stop.`,
      location: "No tight invalidation under the trigger.",
      trigger,
      invalidation: roundPx(orLow),
      target: null,
      flatTitle: "Do not buy",
      flatDetail: `Skip it. A day-trade stop that is wider than 1.2% is a swing, and this desk will not pretend otherwise. ${flatAlways}`,
      orHigh: roundPx(orHigh),
      orLow: roundPx(orLow),
      riskPct: null,
      rr: null,
      rangeReady: true,
    };
  }

  const invalidation = roundPx(stop);
  const riskDollars = entry - invalidation;
  let target = entry + 2 * riskDollars;
  const prevHigh = Math.max(...prior.map((bar) => bar.h));
  if (prevHigh > entry + 1.3 * riskDollars && prevHigh < entry + 2.4 * riskDollars) target = prevHigh;
  target = roundPx(target);
  const riskPct = Math.round((riskDollars / entry) * 1000) / 10;
  const rr = Math.round(((target - entry) / riskDollars) * 10) / 10;
  const light = pace < 1.1;
  const gap = ((orHigh - price) / price) * 100;
  const tooLate = sessionOpen && clock >= 15 * 60 + 10;
  const canTravel = travel !== "quiet";

  let stance: Stance;
  let location: string;
  let flatTitle: string;
  let flatDetail: string;
  let why: string;
  const above = `${symbol} is above VWAP (${money(roundPx(vwap))}). Opening range ${money(roundPx(orLow))}–${money(trigger)}. Pace is ${pace.toFixed(1)}× a normal day.`;

  if (!(target > entry) || price >= target) {
    stance = "pass";
    location = "The measured target is not above the last price.";
    flatTitle = "Nothing left in this plan";
    flatDetail = `The day target was ${money(target)}. Do not invent a higher one. ${flatAlways}`;
    why = `${above} Price has already cleared the measured target.`;
  } else if (price <= invalidation) {
    stance = "pass";
    location = `Price is through invalidation at ${money(invalidation)}.`;
    flatTitle = "The trade is over";
    flatDetail = `Do not re-enter the same opening-range plan. ${flatAlways}`;
    why = `${above} The stop at ${money(invalidation)} already failed.`;
  } else if (broke && !canTravel && !closed) {
    stance = "wait";
    location =
      typicalPct != null
        ? `Range broke, but a typical day is only ${typicalPct.toFixed(1)}%. Not a mover.`
        : "Range broke, but this name is not a mover.";
    flatTitle = "Not enough movement";
    flatDetail = `A day buy needs a typical day of at least 3.5%, a coil against the highs, or a session already running about 2% with pace. ${flatAlways}`;
    why = `${above} The opening range gave way, and the stock still does not travel enough. Skip it.`;
  } else if (broke && price <= chaseCap && !light && canTravel && !closed) {
    stance = "buy";
    location = `Through ${money(trigger)} and still inside the buy window.`;
    flatTitle = "Flat by the close";
    flatDetail = `Buy between ${money(trigger)} and ${money(roundPx(chaseCap))}. Out under ${money(invalidation)}, or at ${money(target)}, and anyway by 15:50 ET. Do not hold overnight.`;
    why = `${above} It can move, the opening-range high is the trigger, and price is there now.`;
  } else if (broke && canTravel && light && !closed) {
    stance = "wait";
    location = `It can move, but pace is only ${pace.toFixed(1)}×. Wait for the tape.`;
    flatTitle = "Do not buy a quiet break";
    flatDetail = `Wait for pace of at least 1.1× or skip it. ${flatAlways}`;
    why = `${above} The range is the kind that can travel, and this break does not have the volume yet.`;
  } else if (broke && price > chaseCap) {
    stance = "wait";
    location = `Past ${money(trigger)}. Buy only on a retest, not up here.`;
    flatTitle = "Do not chase";
    flatDetail = `The long is back at ${money(trigger)}, not at this price. If you are already in, hold for ${money(target)} and exit under ${money(invalidation)}. ${flatAlways}`;
    why = `${above} Price ran through the trigger. Paying up is how day trades turn into bad overnight holds.`;
  } else if (closed && broke) {
    stance = "wait";
    location = "Cash session is over. Do not enter this plan now.";
    flatTitle = "Flatten. Do not carry it.";
    flatDetail = `The session that owned ${money(trigger)} is finished. ${flatAlways}`;
    why = `${above} The trigger was for the regular session, and that session is closed.`;
  } else if (gap > 1.2) {
    stance = "pass";
    location = `Trigger is ${gap.toFixed(1)}% overhead. Too far for a day trade.`;
    flatTitle = "Do not anticipate it";
    flatDetail = `The only long is ${money(trigger)}. It is not close. ${flatAlways}`;
    why = `${above} A push through ${money(trigger)} is more than 1.2% from here. That is not this session's trade.`;
  } else if (!canTravel) {
    stance = "wait";
    location =
      typicalPct != null
        ? `A typical day is only ${typicalPct.toFixed(1)}%. Not a mover.`
        : "Not a mover.";
    flatTitle = "Not enough movement";
    flatDetail = `Do not buy it if the opening range breaks. A day buy needs a wide typical day, a coil, or a session already running. ${flatAlways}`;
    why = `${above} This name does not travel enough. The desk will not arm a buy.`;
  } else {
    stance = "wait";
    location = `Trigger is ${money(trigger)}, ${Math.max(gap, 0).toFixed(1)}% above. Do not front-run it.`;
    flatTitle = "No shares until the trigger";
    flatDetail = `Buy only through ${money(trigger)}, with price still above VWAP. Invalidation ${money(invalidation)}, target ${money(target)}. ${flatAlways}`;
    why = `${above} The buy arms if the opening-range high trades. Until then it is a wait.`;
  }

  if (tooLate && stance !== "pass") {
    stance = "wait";
    location = "Past 15:10 ET. No new day trade.";
    flatTitle = "Do not open it";
    flatDetail = `If you are already in, hold toward ${money(target)} and get out under ${money(invalidation)}. Do not add. ${flatAlways}`;
    why = `${above} New longs stop at 15:10 ET so there is time to be flat by 15:50.`;
  }

  if (closed && stance === "buy") {
    stance = "wait";
    location = "Cash session is over. Do not enter this plan now.";
    flatTitle = "Flatten. Do not carry it.";
    flatDetail = `The session that owned ${money(trigger)} is finished. ${flatAlways}`;
    why = `${above} The trigger was for the regular session, and that session is closed.`;
  }

  return {
    ...shell,
    stance,
    why,
    location,
    trigger,
    invalidation,
    target,
    flatTitle,
    flatDetail,
    orHigh: roundPx(orHigh),
    orLow: roundPx(orLow),
    riskPct,
    rr,
    rangeReady: true,
  };
}

export function sessionClockLine(now: Date): string {
  const et = etOf(now.getTime());
  const weekend = et.weekday === "Sat" || et.weekday === "Sun";
  if (weekend) return "Market is closed. A day trade does not carry into Monday.";
  if (et.mins < 9 * 60 + 30) return "Cash session has not opened. The opening range starts at 9:30 ET.";
  if (et.mins < 10 * 60) return "Opening range is still forming. No trigger until 10:00 ET.";
  if (et.mins < 15 * 60 + 10) {
    const left = 15 * 60 + 50 - et.mins;
    return `New longs until 15:10 ET. Be flat in ${left} minutes, at 15:50.`;
  }
  if (et.mins < 15 * 60 + 50) {
    const left = 15 * 60 + 50 - et.mins;
    return `No new day trades. Flatten anything open in ${left} minutes.`;
  }
  if (et.mins < 16 * 60) return "Flatten now. The cash session is ending.";
  return "Cash session is over. Do not hold a day trade overnight.";
}

export function spySessionLine(bars: Bar[], now: Date): string {
  const trade = analyzeSession({ symbol: "SPY", name: "SPDR S&P 500", bars, now });
  if (!trade) return "SPY's session could not be read. Treat every long with extra doubt.";
  const side = trade.price >= trade.vwap ? "above" : "under";
  return side === "above"
    ? `SPY is above its session VWAP (${money(trade.vwap)}). Intraday longs are allowed.`
    : `SPY is under its session VWAP (${money(trade.vwap)}). Long day trades have a headwind.`;
}
