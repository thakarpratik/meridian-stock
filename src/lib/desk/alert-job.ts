/**
 * Push Meridian swing buys, stop-loss hits and target hits to a phone through ntfy.
 *
 * Called every two minutes during the session by cron-job.org hitting
 * /api/alert-run. Each new buy:
 *
 * - Holding or rising at the signal: push now, with the stop to set.
 * - Still falling at the signal: hold it on a watch list, track the lowest
 *   price since, and push once price recovers a quarter of the stock's typical
 *   daily range off that low. A watched setup is dropped if price trades
 *   through the stop, the room to target shrinks under 8%, or the next session
 *   ends without a bounce.
 *
 * Every pushed buy becomes an open position. Once any 5-minute bar after the
 * push trades at or under the stop, a STOP push says to get out; at or over
 * the target, a TARGET push says to take it. Either closes the position.
 *
 * A setup is its symbol plus trigger, so a fresh pullback on the same stock
 * alerts again. State lives in one private Vercel Blob file.
 */
import { get, put } from "@vercel/blob";

import { type AlertsPayload, buildAlerts } from "./build";
import { isSession, nyDay, nyMinutes, prevSession, shortDay, weekStart } from "./calendar";
import { DIP_HOLD_SESSIONS, DIP_SLOTS } from "./dip";
import { STRENGTH_COUNT } from "./strength";

/**
 * Pullback BUY pushes are off since 2026-11-20: the backtest showed no edge.
 * Dip buys (./dip.ts) replace them. Open pullback positions still get their
 * STOP and TARGET pushes.
 */
const PULLBACK_BUYS = false;
/** Dip buys are pushed from 9:00 ET until this many minutes past midnight. */
const DIP_BUY_UNTIL = 9 * 60 + 35;
/** On the 10th session, the sell push goes out from this time. */
const DIP_SELL_FROM = 15 * 60 + 30;

type AlertBuy = AlertsPayload["buys"][number];
type TapeBar = AlertsPayload["tape"][string]["bars"][number];

const STATE_PATH = process.env.ALERT_STATE_PATH?.trim() || "meridian/alert-state.json";
const KEEP_MS = 10 * 24 * 60 * 60 * 1000;
/** Positions with no stop or target hit are forgotten after this long. */
const POSITION_MS = 30 * 24 * 60 * 60 * 1000;
/** Bounce needed off the low, as a share of a typical day's range. */
const BOUNCE_OF_DAY = 0.25;
/** Same floor the desk uses before it calls a buy. */
const MIN_UPSIDE = 0.08;
/** Watch through the signal's session and the next one. */
const WATCH_SESSIONS = 2;
const BAR_MS = 5 * 60 * 1000;
const PUSH_TRIES = 3;

type Watch = {
  symbol: string;
  name: string;
  trigger: number | null;
  target: number | null;
  invalidation: number;
  atrPct: number;
  signalPrice: number;
  low: number;
  armedAt: number;
};

type Position = {
  symbol: string;
  name: string;
  entry: number;
  stop: number;
  target: number | null;
  openedAt: number;
};

type DipPosition = {
  symbol: string;
  name: string;
  buyDay: string;
  sellDay: string;
  signalClose: number;
  /** The buy day's opening price, filled in once the session opens. */
  entry: number | null;
};

/** The strength list as of the last weekly rebalance push. */
type StrengthHeld = { week: string; holdings: string[] };

type State = {
  sent: Record<string, number>;
  watching: Record<string, Watch>;
  open: Record<string, Position>;
  dips: Record<string, DipPosition>;
  strength?: StrengthHeld;
};

type Note = { title: string; message: string; priority?: number; tags?: string[] };

function env(name: string): string {
  return process.env[name]?.trim().replace(/^["']|["']$/g, "") ?? "";
}

/** The Blob integration may expose the token under a prefixed name. */
function blobToken(): string | undefined {
  const names = Object.keys(process.env).filter((key) => key.endsWith("READ_WRITE_TOKEN"));
  for (const name of ["BLOB_READ_WRITE_TOKEN", ...names]) {
    const token = env(name);
    if (token.startsWith("vercel_blob_rw_")) return token;
  }
  return undefined;
}

async function readState(): Promise<State> {
  const token = blobToken();
  try {
    const result = await get(STATE_PATH, { access: "private", useCache: false, ...(token ? { token } : {}) });
    if (!result || result.statusCode !== 200 || !result.stream) return { sent: {}, watching: {}, open: {}, dips: {} };
    const raw = JSON.parse(await new Response(result.stream).text()) as Partial<State>;
    return {
      sent: raw.sent ?? {},
      watching: raw.watching ?? {},
      open: raw.open ?? {},
      dips: raw.dips ?? {},
      ...(raw.strength ? { strength: raw.strength } : {}),
    };
  } catch (error) {
    // A missing file is a first run; anything else must not double-push, so stop.
    if (error instanceof Error && /not.?found|404/i.test(error.message)) {
      return { sent: {}, watching: {}, open: {}, dips: {} };
    }
    throw error;
  }
}

async function writeState(state: State): Promise<void> {
  const token = blobToken();
  await put(STATE_PATH, JSON.stringify(state, null, 2), {
    access: "private",
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: "application/json",
    cacheControlMaxAge: 60,
    ...(token ? { token } : {}),
  });
}

function nyParts(date: Date): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
}

export function inRegularSession(now: Date): boolean {
  if (!isSession(nyDay(now))) return false;
  const mins = nyMinutes(now);
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

/** 9:00–9:29 ET on a trading day: dip buys go out before the open. */
function inPreOpen(now: Date): boolean {
  if (!isSession(nyDay(now))) return false;
  const mins = nyMinutes(now);
  return mins >= 9 * 60 && mins < 9 * 60 + 30;
}

/** Weekday sessions from the one containing `from` up to and including today's. */
function sessionsSince(from: number, now: Date): number {
  const day = (date: Date) => {
    const parts = nyParts(date);
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  };
  let count = 0;
  for (let t = day(new Date(from)); t <= day(now); t += 24 * 60 * 60 * 1000) {
    const weekday = new Date(t).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}

/** Lower than 15 minutes ago and still printing a fresh 15-minute low. */
function isFalling(bars: TapeBar[]): boolean {
  if (bars.length < 4) return false;
  const recent = bars.slice(-4);
  const last = recent[3]!;
  return last.c < recent[0]!.c && last.l <= Math.min(...recent.slice(0, 3).map((bar) => bar.l));
}

const money = (n: number | null | undefined) => (n == null ? "—" : `$${n.toFixed(2)}`);
const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

const etClock = (at?: string | number) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(
    at == null ? new Date() : new Date(at),
  );

const etDay = (at: number) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }).format(new Date(at));

async function push(note: Note): Promise<void> {
  const topic = env("NTFY_TOPIC");
  const siteUrl = env("SITE_URL");
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(env("NTFY_URL") || "https://ntfy.sh/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          topic,
          title: note.title,
          message: note.message,
          tags: note.tags ?? ["chart_with_upwards_trend"],
          priority: note.priority ?? 4,
          ...(siteUrl ? { click: siteUrl } : {}),
        }),
      });
      if (!response.ok) throw new Error(`ntfy answered ${response.status}`);
      return;
    } catch (error) {
      if (attempt >= PUSH_TRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
}

function signalPush(buy: AlertBuy, asOf: string): Note {
  const zone = buy.zoneHigh ?? buy.trigger;
  return {
    title: `BUY ${buy.symbol} at ${money(buy.price)} → ${money(buy.target)} (+${buy.upsidePct}%)`,
    message: [
      buy.name,
      `Buy zone ${money(buy.trigger)}–${money(zone)}. Use a limit order at ${money(zone)}; do not chase above it.`,
      `STOP-LOSS: set a stop order at ${money(buy.invalidation)} (risk ${buy.riskPct}%). You will get a STOP alert if it trades there.`,
      `Target ${money(buy.target)}, reward ${buy.rr}× risk. Price as of ${etClock(asOf)} ET.`,
    ].join("\n"),
  };
}

function bouncePush(setup: Watch, price: number): Note {
  const target = setup.target ?? price;
  const upside = ((target - price) / price) * 100;
  const risk = ((price - setup.invalidation) / price) * 100;
  const rr = (target - price) / (price - setup.invalidation);
  return {
    title: `BUY ${setup.symbol} at ${money(price)} → ${money(setup.target)} (+${upside.toFixed(1)}%)`,
    message: [
      setup.name,
      `Retest entry. The signal was ${money(setup.signalPrice)}; price fell to ${money(setup.low)} and turned up.`,
      `This is under the ${money(setup.trigger)} trigger, so the app shows WAIT for it. Use a limit order near ${money(price)}.`,
      `STOP-LOSS: set a stop order at ${money(setup.invalidation)} (risk ${risk.toFixed(1)}%). You will get a STOP alert if it trades there.`,
      `Target ${money(setup.target)}, reward ${rr.toFixed(1)}× risk. Price as of ${etClock()} ET.`,
    ].join("\n"),
  };
}

function stopPush(position: Position, low: number, price: number): Note {
  const loss = ((position.stop - position.entry) / position.entry) * 100;
  return {
    title: `STOP ${position.symbol}: sell, it hit ${money(position.stop)}`,
    message: [
      position.name,
      `Traded down to ${money(low)}, through the ${money(position.stop)} stop. Now ${money(price)}.`,
      `Bought on the ${etDay(position.openedAt)} alert at ${money(position.entry)}. Exit at the stop is ${pct(loss)}.`,
      `If your stop order already filled, nothing to do.`,
    ].join("\n"),
    priority: 5,
    tags: ["rotating_light"],
  };
}

function targetPush(position: Position, high: number, price: number): Note {
  const gain = (((position.target ?? high) - position.entry) / position.entry) * 100;
  return {
    title: `TARGET ${position.symbol}: take profit at ${money(position.target)}`,
    message: [
      position.name,
      `Traded up to ${money(high)}, through the ${money(position.target)} target. Now ${money(price)}.`,
      `Bought on the ${etDay(position.openedAt)} alert at ${money(position.entry)}. Exit at the target is ${pct(gain)}.`,
    ].join("\n"),
    tags: ["moneybag"],
  };
}

function dipBuyPush(dip: AlertsPayload["dips"]["signals"][number], sellDay: string): Note {
  return {
    title: `DIP BUY ${dip.symbol} at the open`,
    message: [
      dip.name,
      `Down ${Math.abs(dip.drop2Pct)}% in two days (RSI(2) ${dip.rsi2}) while in an uptrend. About $${dip.dollarVolM}M trades a day.`,
      `Buy at today's open. Last close ${money(dip.close)}.`,
      `Sell at the close on ${shortDay(sellDay)}, the ${DIP_HOLD_SESSIONS}th trading day. You will get a SELL alert that afternoon.`,
      `The tested rule has no stop: it sells on day ${DIP_HOLD_SESSIONS} whatever happens. Size it so that is fine.`,
    ].join("\n"),
    tags: ["chart_with_downwards_trend"],
  };
}

function dipSellPush(position: DipPosition, price: number | null, late: boolean): Note {
  const change = position.entry && price ? pct(((price - position.entry) / position.entry) * 100) : null;
  return {
    title: late ? `SELL ${position.symbol} now (day ${DIP_HOLD_SESSIONS} passed)` : `SELL ${position.symbol} at today's close`,
    message: [
      position.name,
      `Dip bought at the open on ${shortDay(position.buyDay)}${position.entry ? ` at ${money(position.entry)}` : ""}. Day ${DIP_HOLD_SESSIONS} is ${shortDay(position.sellDay)}.`,
      price != null ? `Now ${money(price)}${change ? ` (${change})` : ""}.` : "",
      late ? "The sell alert was missed on the day. Sell now." : "Sell before the close (market-on-close or a market order before 4:00).",
    ]
      .filter(Boolean)
      .join("\n"),
    tags: ["outbox_tray"],
  };
}

function strengthPush(book: AlertsPayload["strength"], held: string[] | null): Note {
  const now = book.picks.map((pick) => pick.symbol);
  const label = (symbol: string) => {
    const pick = book.picks.find((item) => item.symbol === symbol)!;
    return `${symbol} (${pick.sector}, +${pick.gain12m1Pct}% in 12 months)`;
  };
  if (!held) {
    return {
      title: `STRENGTH: buy these ${now.length} at the open`,
      message: [
        `First week. Buy equal amounts of each:`,
        ...now.map(label),
        `Every Monday you will get the list of what to sell and what to buy, so you always hold the ${STRENGTH_COUNT} strongest.`,
        `Expect deep drops: about −41% at worst in the backtest, more than twice SPY's.`,
      ].join("\n"),
      tags: ["trophy"],
    };
  }
  const buys = now.filter((symbol) => !held.includes(symbol));
  const sells = held.filter((symbol) => !now.includes(symbol));
  const keeps = now.filter((symbol) => held.includes(symbol));
  return {
    title: buys.length
      ? `STRENGTH weekly: sell ${sells.length}, buy ${buys.length} at the open`
      : `STRENGTH weekly: no changes`,
    message: [
      sells.length ? `SELL: ${sells.join(", ")} (left the top ${STRENGTH_COUNT}).` : "",
      buys.length ? `BUY with that money, equal amounts:\n${buys.map(label).join("\n")}` : "",
      keeps.length ? `KEEP: ${keeps.join(", ")}.` : "",
      buys.length ? "" : `Hold all ${STRENGTH_COUNT}. Nothing to trade this week.`,
    ]
      .filter(Boolean)
      .join("\n"),
    tags: ["trophy"],
  };
}

/** Record setups another job already pushed, so they are not pushed again. */
export async function markSent(entries: Record<string, number>): Promise<number> {
  const state = await readState();
  let added = 0;
  for (const [key, at] of Object.entries(entries)) {
    if (!/^[A-Z.\-]+@[\d.]+$/.test(key) || typeof at !== "number" || state.sent[key]) continue;
    state.sent[key] = at;
    added += 1;
  }
  if (added) await writeState(state);
  return added;
}

export type JobResult = { skipped?: string; log: string[] };

let running = false;

export async function runAlertJob({ force = false } = {}): Promise<JobResult> {
  const now = new Date();
  if (!inRegularSession(now) && !inPreOpen(now) && !force) {
    return { skipped: "Outside the regular session.", log: [] };
  }
  if (!env("NTFY_TOPIC")) throw new Error("NTFY_TOPIC is not set on the server.");
  if (running) return { skipped: "A run is already in progress.", log: [] };
  running = true;
  try {
    return await run(now, inRegularSession(now) || (force && !inPreOpen(now)));
  } finally {
    running = false;
  }
}

/** `live` is false before the open: only dip buys go out then. */
async function run(now: Date, live: boolean): Promise<JobResult> {
  const log: string[] = [];
  const state = await readState();
  const { sent, watching, open, dips: held } = state;
  let changed = false;

  for (const [key, at] of Object.entries(sent)) {
    if (now.getTime() - at > KEEP_MS) {
      delete sent[key];
      changed = true;
    }
  }
  for (const [key, position] of Object.entries(open)) {
    if (now.getTime() - position.openedAt > POSITION_MS) {
      delete open[key];
      changed = true;
      log.push(`Forgot ${key}: no stop or target hit in 30 days.`);
    }
  }

  const extra = [...Object.values(held), ...Object.values(watching), ...Object.values(open)].map((item) => item.symbol);
  const { asOf, buys: armed, tape, dips, strength } = await buildAlerts([...new Set(extra)]);
  const buys = PULLBACK_BUYS ? armed : [];

  const send = async (key: string, note: Note): Promise<boolean> => {
    try {
      await push(note);
      return true;
    } catch (error) {
      log.push(`${key}: push failed, ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const openPosition = (key: string, position: Position) => {
    sent[key] = now.getTime();
    open[key] = position;
    changed = true;
  };

  const today = nyDay(now);
  const mins = nyMinutes(now);

  // 0. Dip buys, from 9:00 ET to just after the open, on the buy day only.
  if (mins <= DIP_BUY_UNTIL && dips.buyDay === today && dips.sellDay) {
    if (!dips.allowed) {
      if (dips.signals.length) log.push(`Dip buys off (${dips.line}) Skipped ${dips.signals.map((d) => d.symbol).join(", ")}.`);
    } else {
      for (const dip of dips.signals) {
        const key = `${dip.symbol}@${today}`;
        if (held[key]) continue;
        if (Object.keys(held).length >= DIP_SLOTS) {
          log.push(`Dip ${dip.symbol}: all ${DIP_SLOTS} dip slots are full. Skipped.`);
          continue;
        }
        if (Object.values(held).some((position) => position.symbol === dip.symbol)) continue;
        if (await send(key, dipBuyPush(dip, dips.sellDay))) {
          held[key] = {
            symbol: dip.symbol,
            name: dip.name,
            buyDay: today,
            sellDay: dips.sellDay,
            signalClose: dip.close,
            entry: null,
          };
          changed = true;
          log.push(`Pushed DIP ${key}: RSI(2) ${dip.rsi2}, close ${money(dip.close)}, sell ${dips.sellDay}.`);
        }
      }
    }
  }

  // 0a. Weekly strength rebalance, on the week's first run in the buy window,
  // from a ranking on the last close.
  const week = weekStart(today);
  if (
    mins <= DIP_BUY_UNTIL &&
    state.strength?.week !== week &&
    strength.asOfDay === prevSession(today) &&
    strength.picks.length === STRENGTH_COUNT
  ) {
    const heldBefore = state.strength?.holdings ?? null;
    if (await send(`strength@${week}`, strengthPush(strength, heldBefore))) {
      state.strength = { week, holdings: strength.picks.map((pick) => pick.symbol) };
      changed = true;
      log.push(`Pushed STRENGTH ${week}: ${state.strength.holdings.join(", ")}.`);
    }
  }

  // 0b. Dip fills and day-10 sells.
  for (const [key, position] of Object.entries(held)) {
    const quote = tape[position.symbol];
    if (live && position.entry == null && quote) {
      const first = quote.bars.find((bar) => nyDay(bar.t) === position.buyDay);
      if (first) {
        position.entry = Math.round(first.o * 100) / 100;
        changed = true;
        log.push(`Dip ${key}: opened at ${money(position.entry)}.`);
      }
    }
    const late = today > position.sellDay;
    if (!late && !(live && today === position.sellDay && mins >= DIP_SELL_FROM)) continue;
    if (await send(key, dipSellPush(position, quote?.price ?? null, late))) {
      delete held[key];
      changed = true;
      const result = position.entry && quote ? ` (${pct(((quote.price - position.entry) / position.entry) * 100)})` : "";
      log.push(`SELL DIP ${key} at ${money(quote?.price)}${result}.`);
    }
  }

  if (!live) {
    log.push(`Before the open: ${dips.signals.length} dip signals, ${Object.keys(held).length} dip positions.`);
    if (changed) await writeState(state);
    return { log };
  }

  // 1. Stops and targets on open positions.
  for (const [key, position] of Object.entries(open)) {
    const quote = tape[position.symbol];
    if (!quote) {
      log.push(`${key}: no prices this run. Still holding.`);
      continue;
    }
    const since = quote.bars.filter((bar) => bar.t >= position.openedAt);
    const low = Math.min(quote.price, ...since.map((bar) => bar.l));
    const high = Math.max(quote.price, ...since.map((bar) => bar.h));
    if (low <= position.stop) {
      if (await send(key, stopPush(position, low, quote.price))) {
        delete open[key];
        changed = true;
        log.push(`STOP ${key}: low ${money(low)} under ${money(position.stop)}.`);
      }
      continue;
    }
    if (position.target != null && high >= position.target) {
      if (await send(key, targetPush(position, high, quote.price))) {
        delete open[key];
        changed = true;
        log.push(`TARGET ${key}: high ${money(high)} over ${money(position.target)}.`);
      }
    }
  }

  // 2. New buys.
  for (const buy of buys) {
    const key = `${buy.symbol}@${buy.trigger}`;
    if (sent[key] || watching[key]) continue;
    const bars = tape[buy.symbol]?.bars ?? [];
    if (isFalling(bars)) {
      watching[key] = {
        symbol: buy.symbol,
        name: buy.name,
        trigger: buy.trigger,
        target: buy.target,
        invalidation: buy.invalidation,
        atrPct: buy.atrPct,
        signalPrice: buy.price,
        low: Math.min(buy.price, bars[bars.length - 1]!.l),
        armedAt: now.getTime(),
      };
      changed = true;
      log.push(`Holding ${key}: still falling at ${money(buy.price)}. Waiting for a bounce.`);
      continue;
    }
    if (await send(key, signalPush(buy, asOf))) {
      openPosition(key, {
        symbol: buy.symbol,
        name: buy.name,
        entry: buy.price,
        stop: buy.invalidation,
        target: buy.target,
        openedAt: now.getTime(),
      });
      log.push(`Pushed ${key} at ${money(buy.price)}, zone to ${money(buy.zoneHigh)}, stop ${money(buy.invalidation)}.`);
    }
  }

  // 3. Setups waiting for a bounce.
  for (const [key, setup] of Object.entries(watching)) {
    if (setup.armedAt === now.getTime()) continue;
    const quote = tape[setup.symbol];
    if (!quote) {
      log.push(`${key}: no prices this run. Still watching.`);
      continue;
    }
    const since = quote.bars.filter((bar) => bar.t >= setup.armedAt - BAR_MS);
    const low = Math.min(setup.low, quote.price, ...since.map((bar) => bar.l));
    if (low !== setup.low) {
      setup.low = low;
      changed = true;
    }
    const drop = () => {
      delete watching[key];
      changed = true;
    };
    if (low <= setup.invalidation) {
      drop();
      log.push(`Dropped ${key}: traded down to ${money(low)}, through the stop at ${money(setup.invalidation)}.`);
      continue;
    }
    if (sessionsSince(setup.armedAt, now) > WATCH_SESSIONS) {
      drop();
      log.push(`Dropped ${key}: no bounce by the end of the next session.`);
      continue;
    }
    const price = quote.price;
    const bounce = low * ((setup.atrPct ?? 3.5) / 100) * BOUNCE_OF_DAY;
    if (price >= low + bounce) {
      if (setup.target == null || (setup.target - price) / price < MIN_UPSIDE) {
        drop();
        log.push(`Dropped ${key}: bounced to ${money(price)}, but under 8% is left to ${money(setup.target)}.`);
        continue;
      }
      if (await send(key, bouncePush(setup, price))) {
        drop();
        openPosition(key, {
          symbol: setup.symbol,
          name: setup.name,
          entry: price,
          stop: setup.invalidation,
          target: setup.target,
          openedAt: now.getTime(),
        });
        log.push(`Pushed ${key} on the retest: low ${money(low)}, now ${money(price)}.`);
      }
      continue;
    }
    log.push(`Watching ${key}: low ${money(low)}, now ${money(price)}, needs ${money(low + bounce)}.`);
  }

  log.push(
    `${Object.keys(held).length} dip positions, ${armed.length} pullback buys (not pushed), ${Object.keys(watching).length} waiting for a bounce, ${Object.keys(open).length} open with a stop.`,
  );
  if (changed) await writeState(state);
  return { log };
}
