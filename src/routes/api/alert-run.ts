import { createFileRoute } from "@tanstack/react-router";

import { markSent, runAlertJob } from "@/lib/desk/alert-job";

function fixedEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/**
 * The push job, called every two minutes by cron-job.org:
 *   GET /api/alert-run?key=<ALERT_SECRET>        (add &force=1 to run outside the session)
 * or with the header  Authorization: Bearer <ALERT_SECRET>.
 */
async function handle(request: Request): Promise<Response> {
  const secret = process.env.ALERT_SECRET?.trim() ?? "";
  const url = new URL(request.url);
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const given = url.searchParams.get("key") || bearer;
  if (secret.length < 16 || !fixedEqual(given, secret)) {
    return Response.json({ error: "Not allowed." }, { status: 401 });
  }
  try {
    // POST {"sent": {"SYM@trigger": epochMs}} records setups pushed elsewhere, without running.
    if (request.method === "POST" && request.headers.get("content-type")?.includes("application/json")) {
      const body = (await request.json()) as { sent?: Record<string, number> };
      return Response.json({ added: await markSent(body.sent ?? {}) });
    }
    const result = await runAlertJob({ force: url.searchParams.get("force") === "1" });
    for (const line of result.log) console.log(line);
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return Response.json({ error: message }, { status: 500 });
  }
}

export const Route = createFileRoute("/api/alert-run")({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
    },
  },
});
