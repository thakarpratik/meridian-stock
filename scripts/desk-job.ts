/**
 * Scheduled desk job, run by .github/workflows/buy-alerts.yml.
 *
 * 1. Builds the swing desk and the day book from Yahoo prices.
 * 2. Writes them to $SNAPSHOT_FILE (default out/desk.json). The Claude-hosted
 *    page reads this file, so it shows the desk without a server of its own.
 * 3. Serves /api/alerts on a local port from the same desk and runs
 *    scripts/buy-alerts.mjs against it, when NTFY_TOPIC is set.
 *
 * Run with: npx tsx scripts/desk-job.ts
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";

import { buildAlerts, getDayBook, getDesk } from "../src/lib/desk/build";
import type { DayBook } from "../src/lib/desk/types";

const snapshotFile = process.env.SNAPSHOT_FILE || "out/desk.json";

async function main() {
  const desk = await getDesk(true);
  let day: DayBook | null = null;
  try {
    day = await getDayBook(false);
  } catch (error) {
    console.warn("Day book skipped:", error instanceof Error ? error.message : error);
  }

  await mkdir(dirname(snapshotFile), { recursive: true });
  await writeFile(snapshotFile, JSON.stringify({ desk, day }));
  const buys = desk.plans.filter((plan) => plan.stance === "buy").length;
  console.log(
    `Snapshot written: ${desk.plans.length} plans, ${buys} buys, day book ${day ? "ready" : "missing"}.`,
  );

  if (!process.env.NTFY_TOPIC) {
    console.log("NTFY_TOPIC not set, so no alerts were checked.");
    return;
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/alerts") {
      response.writeHead(404).end();
      return;
    }
    try {
      const payload = await buildAlerts((url.searchParams.get("watch") ?? "").split(","), desk);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
    } catch (error) {
      response.writeHead(500).end(error instanceof Error ? error.message : "Alerts failed.");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const code = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, ["scripts/buy-alerts.mjs"], {
      stdio: "inherit",
      env: { ...process.env, ALERTS_URL: `http://127.0.0.1:${port}/api/alerts` },
    });
    child.on("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  server.close();
  process.exitCode = code;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
