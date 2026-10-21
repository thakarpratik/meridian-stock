import { createFileRoute } from "@tanstack/react-router";

import { fetchIntraday, getDesk } from "@/lib/desk/load";
import { BOOK_BY_SYMBOL } from "@/lib/desk/universe";

const MAX_WATCH = 20;

/**
 * Armed swing buys as JSON, for the scheduled alert job
 * (.github/workflows/buy-alerts.yml). The desk already demands the minimum
 * upside before it calls a buy, so this only filters and trims.
 *
 * `?watch=AAA,BBB` adds 5-minute bars for setups the job is holding for a
 * bounce. Those have usually dropped under their trigger and left `buys`, so
 * the job needs their prices from here. Every buy gets bars too, so the job
 * can tell whether it is still falling when it arms.
 */
export const Route = createFileRoute("/api/alerts")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const desk = await getDesk(false);
        const buys = desk.plans
          .filter((plan) => plan.stance === "buy" && plan.move !== "steady")
          .map((plan) => ({
            symbol: plan.symbol,
            name: plan.name,
            price: plan.price,
            trigger: plan.trigger,
            invalidation: plan.invalidation,
            target: plan.target,
            upsidePct: plan.upsidePct,
            riskPct: plan.riskPct,
            rr: plan.rr,
            atrPct: plan.atrPct,
            location: plan.location,
          }));

        const watch = (new URL(request.url).searchParams.get("watch") ?? "")
          .split(",")
          .map((symbol) => symbol.trim().toUpperCase())
          .filter((symbol) => BOOK_BY_SYMBOL.has(symbol))
          .slice(0, MAX_WATCH);
        const symbols = [...new Set([...buys.map((buy) => buy.symbol), ...watch])];
        const charts = await Promise.all(
          symbols.map(async (symbol) => [symbol, await fetchIntraday(symbol)] as const),
        );
        const tape: Record<string, { price: number; bars: { t: number; h: number; l: number; c: number }[] }> = {};
        for (const [symbol, chart] of charts) {
          if (!chart) continue;
          tape[symbol] = {
            price: chart.bars[chart.bars.length - 1]!.c,
            bars: chart.bars.map((bar) => ({ t: bar.t, h: bar.h, l: bar.l, c: bar.c })),
          };
        }

        return Response.json(
          { asOf: desk.asOf, buys, tape },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
