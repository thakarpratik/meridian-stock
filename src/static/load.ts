/**
 * Stands in for `@/lib/desk/load` in the static build (vite.static.config.ts).
 * There is no server, so both loaders read desk.json, the snapshot the
 * scheduled job writes next to the page.
 */
import type { DayBook, Desk } from "@/lib/desk/types";

export type Snapshot = { desk: Desk; day: DayBook | null };

let latest: Promise<Snapshot> | null = null;

export function readSnapshot(force = false): Promise<Snapshot> {
  if (!latest || force) {
    latest = fetch(`./desk.json?t=${Date.now()}`, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("The desk snapshot did not load.");
        return response.json() as Promise<Snapshot>;
      })
      .catch((error: unknown) => {
        latest = null;
        throw error;
      });
  }
  return latest;
}

type Input = { data: { force: boolean } };

export async function loadDesk({ data }: Input): Promise<Desk> {
  return (await readSnapshot(data.force)).desk;
}

export async function loadDay({ data }: Input): Promise<DayBook> {
  const { day } = await readSnapshot(data.force);
  if (!day)
    throw new Error("The day book was not in the last snapshot. It returns on the next run.");
  return day;
}
