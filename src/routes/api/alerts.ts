import { createFileRoute } from "@tanstack/react-router";

import { buildAlerts } from "@/lib/desk/build";

/** Armed swing buys as JSON. See `buildAlerts` for the shape. */
export const Route = createFileRoute("/api/alerts")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const watch = (new URL(request.url).searchParams.get("watch") ?? "").split(",");
        return Response.json(await buildAlerts(watch), {
          headers: { "cache-control": "no-store" },
        });
      },
    },
  },
});
