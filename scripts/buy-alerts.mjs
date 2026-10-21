#!/usr/bin/env node
/**
 * Push new Meridian swing buys to a phone through ntfy.
 *
 * Run on a schedule by .github/workflows/buy-alerts.yml. Reads the deployed
 * desk's /api/alerts, sends one ntfy push per buy not already announced, and
 * records what it sent in a small JSON state file so the next run stays quiet
 * about the same setup. A setup is its symbol plus trigger: a fresh pullback on
 * the same stock gets a new trigger and alerts again.
 *
 * Env: ALERTS_URL (the /api/alerts endpoint), NTFY_TOPIC, optional SITE_URL
 * (opened when the push is tapped) and STATE_FILE.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const alertsUrl = process.env.ALERTS_URL;
const topic = process.env.NTFY_TOPIC;
const siteUrl = process.env.SITE_URL;
const stateFile = process.env.STATE_FILE || ".alert-state/sent.json";
const KEEP_MS = 10 * 24 * 60 * 60 * 1000;

if (!alertsUrl || !topic) {
  console.error("ALERTS_URL and NTFY_TOPIC are required.");
  process.exit(2);
}

/** The cron covers both EST and EDT, so trim to the regular session here. */
function inRegularSession(now) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

async function readState() {
  try {
    return JSON.parse(await readFile(stateFile, "utf8"));
  } catch {
    return {};
  }
}

const money = (n) => (n == null ? "—" : `$${n.toFixed(2)}`);

async function push(buy) {
  const response = await fetch("https://ntfy.sh/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      topic,
      title: `BUY ${buy.symbol} at ${money(buy.price)} → ${money(buy.target)} (+${buy.upsidePct}%)`,
      message: [
        buy.name,
        `Buy through ${money(buy.trigger)}. Stop on a close under ${money(buy.invalidation)}.`,
        `Target ${money(buy.target)}. Risk ${buy.riskPct}%, reward ${buy.rr}× risk.`,
      ].join("\n"),
      tags: ["chart_with_upwards_trend"],
      priority: 4,
      ...(siteUrl ? { click: siteUrl } : {}),
    }),
  });
  if (!response.ok) throw new Error(`ntfy answered ${response.status} for ${buy.symbol}`);
}

async function main() {
  const now = new Date();
  if (!inRegularSession(now) && process.env.FORCE !== "1") {
    console.log("Outside the regular session. Nothing to check.");
    return;
  }

  const response = await fetch(alertsUrl, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${alertsUrl} answered ${response.status}`);
  const { buys } = await response.json();

  const sent = await readState();
  let pruned = 0;
  for (const [key, at] of Object.entries(sent)) {
    if (now.getTime() - at > KEEP_MS) {
      delete sent[key];
      pruned += 1;
    }
  }

  let pushed = 0;
  for (const buy of buys) {
    const key = `${buy.symbol}@${buy.trigger}`;
    if (sent[key]) continue;
    try {
      await push(buy);
    } catch (error) {
      // Keep going so pushes that did land are still recorded; retry next run.
      console.error(error);
      process.exitCode = 1;
      continue;
    }
    sent[key] = now.getTime();
    pushed += 1;
    console.log(`Pushed ${key} (+${buy.upsidePct}%).`);
  }
  console.log(`${buys.length} armed buys, ${pushed} new.`);
  if (pushed === 0 && pruned === 0) return;

  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify(sent, null, 2));
  // Tell the workflow to save a new cache entry only when the state moved.
  if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, "changed=true\n", { flag: "a" });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
