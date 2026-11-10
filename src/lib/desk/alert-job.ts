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

type State = {
  sent: Record<string, number>;
  watching: Record<string, Watch>;
  open: Record<string, Position>;
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
    if (!result || result.statusCode !== 200 || !result.stream) return { sent: {}, watching: {}, open: {} };
    const raw = JSON.parse(await new Response(result.stream).text()) as Partial<State>;
    return { sent: raw.sent ?? {}, watching: raw.watching ?? {}, open: raw.open ?? {} };
  } catch (error) {
    // A missing file is a first run; anything else must not double-push, so stop.
    if (error instanceof Error && /not.?found|404/i.test(error.message)) return { sent: {}, watching: {}, open: {} };
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
  const parts = nyParts(now);
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
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
  if (!inRegularSession(now) && !force) return { skipped: "Outside the regular session.", log: [] };
  if (!env("NTFY_TOPIC")) throw new Error("NTFY_TOPIC is not set on the server.");
  if (running) return { skipped: "A run is already in progress.", log: [] };
  running = true;
  try {
    return await run(now);
  } finally {
    running = false;
  }
}

async function run(now: Date): Promise<JobResult> {
  const log: string[] = [];
  const state = await readState();
  const { sent, watching, open } = state;
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

  const extra = [...Object.values(watching), ...Object.values(open)].map((item) => item.symbol);
  const { asOf, buys, tape } = await buildAlerts([...new Set(extra)]);

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
    `${buys.length} armed buys, ${Object.keys(watching).length} waiting for a bounce, ${Object.keys(open).length} open with a stop.`,
  );
  if (changed) await writeState(state);
  return { log };
}
