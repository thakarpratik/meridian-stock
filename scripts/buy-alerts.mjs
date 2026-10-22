#!/usr/bin/env node
/**
 * Push new Meridian swing buys to a phone through ntfy.
 *
 * Run on a schedule by .github/workflows/buy-alerts.yml. Reads the deployed
 * desk's /api/alerts and handles each buy not already announced:
 *
 * - Holding or rising at the signal: push now.
 * - Still falling at the signal: hold it on a watch list instead, track the
 *   lowest price since, and push once price recovers a quarter of the stock's
 *   typical daily range off that low — a lower entry than the signal.
 *   A watched setup is dropped if price trades through the stop, the room to
 *   target shrinks under 8%, or the next session ends without a bounce.
 *
 * A setup is its symbol plus trigger, so a fresh pullback on the same stock
 * gets a new trigger and alerts again. What was sent and what is being watched
 * live in a small JSON state file carried between runs.
 *
 * Env: ALERTS_URL (the /api/alerts endpoint), NTFY_TOPIC, optional SITE_URL
 * (opened when the push is tapped), STATE_FILE and NTFY_URL.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const alertsUrl = process.env.ALERTS_URL;
const topic = process.env.NTFY_TOPIC;
const siteUrl = process.env.SITE_URL;
const stateFile = process.env.STATE_FILE || ".alert-state/sent.json";
const ntfyUrl = process.env.NTFY_URL || "https://ntfy.sh/";
const KEEP_MS = 10 * 24 * 60 * 60 * 1000;
/** Bounce needed off the low, as a share of a typical day's range. */
const BOUNCE_OF_DAY = 0.25;
/** Same floor the desk uses before it calls a buy. */
const MIN_UPSIDE = 0.08;
/** Watch through the signal's session and the next one. */
const WATCH_SESSIONS = 2;
const BAR_MS = 5 * 60 * 1000;

if (!alertsUrl || !topic) {
  console.error("ALERTS_URL and NTFY_TOPIC are required.");
  process.exit(2);
}

function nyParts(date) {
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

/** The cron covers both EST and EDT, so trim to the regular session here. */
function inRegularSession(now) {
  const parts = nyParts(now);
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

/** Weekday sessions from the one containing `from` up to and including today's. */
function sessionsSince(from, now) {
  const day = (date) => {
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
function isFalling(bars) {
  if (bars.length < 4) return false;
  const recent = bars.slice(-4);
  const last = recent[3];
  return last.c < recent[0].c && last.l <= Math.min(...recent.slice(0, 3).map((bar) => bar.l));
}

async function readState() {
  try {
    const raw = JSON.parse(await readFile(stateFile, "utf8"));
    // The first version stored only the sent map.
    if (!("sent" in raw)) return { sent: raw, watching: {} };
    return { sent: raw.sent ?? {}, watching: raw.watching ?? {} };
  } catch {
    return { sent: {}, watching: {} };
  }
}

const money = (n) => (n == null ? "—" : `$${n.toFixed(2)}`);

async function push({ title, message }) {
  const response = await fetch(ntfyUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      topic,
      title,
      message,
      tags: ["chart_with_upwards_trend"],
      priority: 4,
      ...(siteUrl ? { click: siteUrl } : {}),
    }),
  });
  if (!response.ok) throw new Error(`ntfy answered ${response.status}`);
}

function signalPush(buy) {
  return {
    title: `BUY ${buy.symbol} at ${money(buy.price)} → ${money(buy.target)} (+${buy.upsidePct}%)`,
    message: [
      buy.name,
      `Buy through ${money(buy.trigger)}. Stop on a close under ${money(buy.invalidation)}.`,
      `Target ${money(buy.target)}. Risk ${buy.riskPct}%, reward ${buy.rr}× risk.`,
    ].join("\n"),
  };
}

function bouncePush(setup, price) {
  const upside = ((setup.target - price) / price) * 100;
  const risk = ((price - setup.invalidation) / price) * 100;
  const rr = (setup.target - price) / (price - setup.invalidation);
  return {
    title: `BUY ${setup.symbol} at ${money(price)} → ${money(setup.target)} (+${upside.toFixed(1)}%)`,
    message: [
      setup.name,
      `Retest entry. The signal was ${money(setup.signalPrice)}; price fell to ${money(setup.low)} and turned up.`,
      `Stop on a close under ${money(setup.invalidation)}. Target ${money(setup.target)}.`,
      `Risk ${risk.toFixed(1)}%, reward ${rr.toFixed(1)}× risk.`,
    ].join("\n"),
  };
}

async function main() {
  const now = new Date();
  if (!inRegularSession(now) && process.env.FORCE !== "1") {
    console.log("Outside the regular session. Nothing to check.");
    return;
  }

  const { sent, watching } = await readState();
  let changed = false;
  for (const [key, at] of Object.entries(sent)) {
    if (now.getTime() - at > KEEP_MS) {
      delete sent[key];
      changed = true;
    }
  }

  const url = new URL(alertsUrl);
  const watchSymbols = [...new Set(Object.values(watching).map((setup) => setup.symbol))];
  if (watchSymbols.length) url.searchParams.set("watch", watchSymbols.join(","));
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const { buys, tape = {} } = await response.json();

  const send = async (key, note) => {
    try {
      await push(note);
    } catch (error) {
      // Keep going so pushes that did land are still recorded; retry next run.
      console.error(`${key}: ${error.message}`);
      process.exitCode = 1;
      return false;
    }
    sent[key] = now.getTime();
    changed = true;
    return true;
  };

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
        low: Math.min(buy.price, bars[bars.length - 1].l),
        armedAt: now.getTime(),
      };
      changed = true;
      console.log(`Holding ${key}: still falling at ${money(buy.price)}. Waiting for a bounce.`);
      continue;
    }
    if (await send(key, signalPush(buy))) console.log(`Pushed ${key} (+${buy.upsidePct}%).`);
  }

  for (const [key, setup] of Object.entries(watching)) {
    // Held this run; the bounce has to come after the low that held it.
    if (setup.armedAt === now.getTime()) continue;
    const quote = tape[setup.symbol];
    if (!quote) {
      console.log(`${key}: no prices this run. Still watching.`);
      continue;
    }
    // Start one bar early so the bar the signal landed in counts.
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
      console.log(`Dropped ${key}: traded down to ${money(low)}, through the stop at ${money(setup.invalidation)}.`);
      continue;
    }
    if (sessionsSince(setup.armedAt, now) > WATCH_SESSIONS) {
      drop();
      console.log(`Dropped ${key}: no bounce by the end of the next session.`);
      continue;
    }
    const price = quote.price;
    const bounce = low * ((setup.atrPct ?? 3.5) / 100) * BOUNCE_OF_DAY;
    if (price >= low + bounce) {
      if ((setup.target - price) / price < MIN_UPSIDE) {
        drop();
        console.log(`Dropped ${key}: bounced to ${money(price)}, but under ${Math.round(MIN_UPSIDE * 100)}% is left to ${money(setup.target)}.`);
        continue;
      }
      if (await send(key, bouncePush(setup, price))) {
        drop();
        console.log(`Pushed ${key} on the retest: low ${money(low)}, now ${money(price)}.`);
      }
      continue;
    }
    console.log(`Watching ${key}: low ${money(low)}, now ${money(price)}, needs ${money(low + bounce)}.`);
  }

  console.log(`${buys.length} armed buys, ${Object.keys(watching).length} waiting for a bounce.`);
  if (!changed) return;

  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ sent, watching }, null, 2));
  // Tell the workflow to save a new cache entry only when the state moved.
  if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, "changed=true\n", { flag: "a" });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
