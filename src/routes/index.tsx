import { createFileRoute, type ErrorComponentProps } from "@tanstack/react-router";

import { DeskApp } from "@/components/desk/desk-app";
import { loadDesk } from "@/lib/desk/load";

export const Route = createFileRoute("/")({
  loader: () => loadDesk({ data: { force: false } }),
  component: Home,
  pendingComponent: DeskPending,
  errorComponent: DeskError,
});

function Home() {
  const desk = Route.useLoaderData();
  return <DeskApp initial={desk} />;
}

function DeskPending() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-8 sm:px-6">
      <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
        Small to large-cap desk
      </p>
      <h1 className="mt-1 font-display text-3xl leading-none">Meridian</h1>
      <p className="mt-4 max-w-md text-sm text-muted-foreground">
        Reading prices. The desk opens on five pullbacks, locked to the last close.
      </p>
    </main>
  );
}

function DeskError({ error }: ErrorComponentProps) {
  const message = error instanceof Error ? error.message : "The tape did not load.";
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-8 sm:px-6">
      <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
        Small to large-cap desk
      </p>
      <h1 className="mt-1 font-display text-3xl leading-none">Meridian</h1>
      <p className="mt-4 max-w-md text-sm text-foreground">The tape did not load.</p>
      <p className="mt-2 max-w-md text-sm break-words text-down">{message}</p>
    </main>
  );
}
