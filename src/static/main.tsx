import { useQuery } from "@tanstack/react-query";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { DeskApp } from "@/components/desk/desk-app";
import { QueryProvider } from "@/components/query-provider";
import type { Desk } from "@/lib/desk/types";
import "../styles.css";
import { readSnapshot } from "./load";

const STALE_MS = 45 * 60 * 1000;

function snapshotTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** Says when the prices were read, since the page shows a saved snapshot. */
function SnapshotNote({ desk }: { desk: Desk }) {
  const { data } = useQuery({ queryKey: ["desk"], queryFn: async () => desk, initialData: desk });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const stale = now - new Date(data.asOf).getTime() > STALE_MS;
  return (
    <p className="mx-auto w-full max-w-6xl px-4 pt-4 text-xs text-muted-foreground sm:px-6">
      Prices read {snapshotTime(data.asOf)} ET.{" "}
      {stale
        ? "Older than the usual refresh, so the market may be closed or the update job is late."
        : "Updated about every 15 minutes while the market is open."}
    </p>
  );
}

function Boot() {
  const [desk, setDesk] = useState<Desk | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    readSnapshot()
      .then((snapshot) => setDesk(snapshot.desk))
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "The desk did not load."),
      );
  }, []);

  if (!desk) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-8 sm:px-6">
        <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
          Small to large-cap desk
        </p>
        <h1 className="mt-1 font-display text-3xl leading-none">Meridian</h1>
        <p className="mt-4 max-w-md text-sm text-muted-foreground">
          {error ?? "Reading prices. The desk opens on five pullbacks, locked to the last close."}
        </p>
      </main>
    );
  }
  return (
    <>
      <SnapshotNote desk={desk} />
      <DeskApp initial={desk} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryProvider>
      <Boot />
    </QueryProvider>
  </StrictMode>,
);
