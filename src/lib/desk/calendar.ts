/** NYSE trading days. Dates are New York calendar days as "YYYY-MM-DD". */

/** Full-day closures. Extend this list each year. */
const HOLIDAYS = new Set([
  "2026-11-26",
  "2026-12-25",
  "2027-01-01",
  "2027-01-18",
  "2027-02-15",
  "2027-03-26",
  "2027-05-31",
  "2027-06-18",
  "2027-07-05",
  "2027-09-06",
  "2027-11-25",
  "2027-12-24",
]);

export function nyDay(at: Date | number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Minutes since midnight, New York time. */
export function nyMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

export function isSession(ymd: string): boolean {
  const weekday = new Date(`${ymd}T12:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !HOLIDAYS.has(ymd);
}

function shift(ymd: string, days: number): string {
  const date = new Date(`${ymd}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The first trading day after `ymd`. */
export function nextSession(ymd: string): string {
  let day = shift(ymd, 1);
  while (!isSession(day)) day = shift(day, 1);
  return day;
}

/** The trading day `n` sessions after `ymd` (n = 0 returns `ymd`). */
export function addSessions(ymd: string, n: number): string {
  let day = ymd;
  for (let i = 0; i < n; i++) day = nextSession(day);
  return day;
}

export function shortDay(ymd: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(
    new Date(`${ymd}T12:00:00Z`),
  );
}
