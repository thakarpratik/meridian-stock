import { createFileRoute } from "@tanstack/react-router";

import { getDesk } from "@/lib/desk/load";

/**
 * Armed swing buys as JSON, for the scheduled alert job
 * (.github/workflows/buy-alerts.yml). The desk already demands the minimum
 * upside before it calls a buy, so this only filters and trims.
 */
export const Route = createFileRoute("/api/alerts")({
  server: {
    handlers: {
      GET: async () => {
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
            location: plan.location,
          }));
        return Response.json(
          { asOf: desk.asOf, buys },
          { headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
