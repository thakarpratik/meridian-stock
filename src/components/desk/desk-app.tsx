import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { PriceChart } from "@/components/desk/price-chart";
import { cn } from "@/lib/cn";
import { compactCap, money, moveLabel, positionCall, signedPct, stanceLabel, tierLabel, travelLabel } from "@/lib/desk/format";
import { loadDay, loadDesk } from "@/lib/desk/load";
import { sessionClockLine } from "@/lib/desk/session";
import type { DayTrade, Desk, Plan, Stance } from "@/lib/desk/types";

const FILTERS = [
  { id: "picks", label: "Top 5" },
  { id: "movers", label: "Can move" },
  { id: "actionable", label: "Buy & wait" },
  { id: "buy", label: "Buy" },
  { id: "wait", label: "Wait" },
  { id: "pass", label: "Pass" },
  { id: "hold", label: "Holding" },
  { id: "all", label: "All" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

const SIZES = [
  { id: "any", label: "All sizes" },
  { id: "small", label: "Small-cap" },
  { id: "mid", label: "Mid-cap" },
  { id: "large", label: "Large-cap" },
] as const;

type SizeId = (typeof SIZES)[number]["id"];

const HOLDS_KEY = "meridian-holds";
const DAY_KEY = "meridian-day-in";
const PICK_COUNT = 5;

export function DeskApp({ initial }: { initial: Desk }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["desk"],
    queryFn: () => loadDesk({ data: { force: false } }),
    initialData: initial,
    staleTime: 60_000,
  });
  const desk = query.data;
  const [mode, setMode] = useState<"swing" | "day">("swing");
  const dayQuery = useQuery({
    queryKey: ["day"],
    queryFn: () => loadDay({ data: { force: false } }),
    enabled: mode === "day",
    staleTime: 45_000,
  });
  const [filter, setFilter] = useState<FilterId>("picks");
  const [size, setSize] = useState<SizeId>("any");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [holds, setHolds] = useState<string[]>([]);
  const [inTrade, setInTrade] = useState<string[]>([]);
  const [holdsReady, setHoldsReady] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [clockLine, setClockLine] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(HOLDS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          setHolds(parsed.filter((item): item is string => typeof item === "string"));
        }
      }
      const rawDay = localStorage.getItem(DAY_KEY);
      if (rawDay) {
        const parsed = JSON.parse(rawDay) as unknown;
        if (Array.isArray(parsed)) {
          setInTrade(parsed.filter((item): item is string => typeof item === "string"));
        }
      }
    } catch {
      /* ignore broken local storage */
    }
    setHoldsReady(true);
  }, []);

  useEffect(() => {
    if (!holdsReady) return;
    localStorage.setItem(HOLDS_KEY, JSON.stringify(holds));
    localStorage.setItem(DAY_KEY, JSON.stringify(inTrade));
  }, [holds, inTrade, holdsReady]);

  useEffect(() => {
    if (mode !== "day") return;
    const tick = () => setClockLine(sessionClockLine(new Date()));
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, [mode]);

  const holdSet = useMemo(() => new Set(holds), [holds]);
  const tradeSet = useMemo(() => new Set(inTrade), [inTrade]);

  const visible = useMemo(() => {
    const queryText = q.trim().toLowerCase();
    const matched = desk.plans.filter((plan) => {
      if (filter === "buy" && plan.stance !== "buy") return false;
      if (filter === "wait" && plan.stance !== "wait") return false;
      if (filter === "pass" && plan.stance !== "pass") return false;
      if (filter === "actionable" && plan.stance === "pass") return false;
      if (filter === "hold" && !holdSet.has(plan.symbol)) return false;
      if (filter === "movers" && plan.move === "steady") return false;
      if (size === "small" && plan.capTier !== "small") return false;
      if (size === "mid" && plan.capTier !== "mid") return false;
      if (size === "large" && plan.capTier !== "large") return false;
      if (!queryText) return true;
      return (
        plan.symbol.toLowerCase().includes(queryText) ||
        plan.name.toLowerCase().includes(queryText) ||
        plan.industry.toLowerCase().includes(queryText)
      );
    });
    if (filter === "picks") return rankSwingPicks(matched);
    if (filter !== "movers") return matched;
    const rank = { buy: 0, wait: 1, pass: 2 };
    return [...matched].sort((a, b) => rank[a.stance] - rank[b.stance] || b.atrPct - a.atrPct);
  }, [desk.plans, filter, q, holdSet, size]);

  const dayVisible = useMemo(() => {
    const book = dayQuery.data;
    if (!book) return [];
    const swingBy = new Map(desk.plans.map((plan) => [plan.symbol, plan]));
    const queryText = q.trim().toLowerCase();
    const matched = book.trades.filter((trade) => {
      const swing = swingBy.get(trade.symbol);
      if (filter === "buy" && trade.stance !== "buy") return false;
      if (filter === "wait" && trade.stance !== "wait") return false;
      if (filter === "pass" && trade.stance !== "pass") return false;
      if (filter === "actionable" && trade.stance === "pass") return false;
      if (filter === "hold" && !tradeSet.has(trade.symbol)) return false;
      if (filter === "movers" && trade.travel === "quiet") return false;
      if (size === "small" && swing?.capTier !== "small") return false;
      if (size === "mid" && swing?.capTier !== "mid") return false;
      if (size === "large" && swing?.capTier !== "large") return false;
      if (!queryText) return true;
      return (
        trade.symbol.toLowerCase().includes(queryText) ||
        trade.name.toLowerCase().includes(queryText) ||
        (swing?.industry.toLowerCase().includes(queryText) ?? false)
      );
    });
    if (filter === "picks") return rankDayPicks(matched);
    if (filter !== "movers") return matched;
    const rank = { buy: 0, wait: 1, pass: 2 };
    return [...matched].sort(
      (a, b) => rank[a.stance] - rank[b.stance] || (b.typicalPct ?? 0) - (a.typicalPct ?? 0) || b.rvol - a.rvol,
    );
  }, [dayQuery.data, desk.plans, filter, q, tradeSet, size]);

  const lookup = lookupMiss(desk, q);

  async function refresh() {
    setRefreshing(true);
    setRefreshError(null);
    try {
      if (mode === "day") {
        const next = await loadDay({ data: { force: true } });
        queryClient.setQueryData(["day"], next);
      } else {
        const next = await loadDesk({ data: { force: true } });
        queryClient.setQueryData(["desk"], next);
      }
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : "Refresh failed.");
    } finally {
      setRefreshing(false);
    }
  }

  function chooseMode(next: "swing" | "day") {
    setMode(next);
    setOpen(null);
    if (next === "day" && filter === "hold") setFilter("picks");
  }

  function toggleHold(symbol: string) {
    setHolds((current) =>
      current.includes(symbol) ? current.filter((item) => item !== symbol) : [...current, symbol],
    );
  }

  function toggleTrade(symbol: string) {
    setInTrade((current) =>
      current.includes(symbol) ? current.filter((item) => item !== symbol) : [...current, symbol],
    );
  }

  const counted = mode === "day" ? dayVisible : visible;
  const counts = {
    buy: counted.filter((plan) => plan.stance === "buy").length,
    wait: counted.filter((plan) => plan.stance === "wait").length,
    pass: counted.filter((plan) => plan.stance === "pass").length,
  };
  const moverCount = desk.plans.filter((plan) => plan.move !== "steady").length;
  const dayLoading = mode === "day" && dayQuery.isFetching && !dayQuery.data;
  const dayError = mode === "day" && dayQuery.error instanceof Error ? dayQuery.error.message : null;

  return (
    <div className="mx-auto min-h-screen w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="flex flex-col gap-6 border-b border-border pb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
              Small to large-cap desk
            </p>
            <h1 className="mt-1 text-3xl leading-none text-foreground">Meridian</h1>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              {mode === "day"
                ? filter === "picks"
                  ? "Five day-trade picks. Each one can move. Trigger is the opening-range high, and only above VWAP. No new entry after 15:10. Flat by 15:50."
                  : "Day longs only on names that can move: a wide typical day, a coil, or a session already running. Trigger is the opening-range high, and only above VWAP. No new entry after 15:10. Flat by 15:50."
                : filter === "picks"
                  ? "Five names that can turn. The buy is not the moving average. A day has to tag the 20-day, and you buy only through that day's high. A headline can still veto it."
                  : "A buy is a turn, not a dip. Price has to tag the 20-day, then trade back through that day's high. Quiet names are not buys. Penny stocks and parabolic spikes stay out."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex h-11 rounded-sm bg-card p-1 ring-1 ring-border">
              <button
                type="button"
                aria-pressed={mode === "swing"}
                onClick={() => chooseMode("swing")}
                className={cn(
                  "h-9 rounded-sm px-3 text-sm font-medium",
                  mode === "swing" ? "bg-accent text-accent-foreground" : "text-foreground",
                )}
              >
                Swing
              </button>
              <button
                type="button"
                aria-pressed={mode === "day"}
                onClick={() => chooseMode("day")}
                className={cn(
                  "h-9 rounded-sm px-3 text-sm font-medium",
                  mode === "day" ? "bg-accent text-accent-foreground" : "text-foreground",
                )}
              >
                Day trade
              </button>
            </div>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={refreshing || dayLoading}
              className="inline-flex h-11 items-center gap-2 rounded-sm border border-border bg-card px-3 text-sm font-medium text-foreground transition-opacity duration-150 ease-out hover:opacity-80 disabled:opacity-50"
            >
              <RefreshCw className={cn("size-4", (refreshing || dayLoading) && "animate-spin")} aria-hidden="true" />
              {refreshing || dayLoading ? "Reading tape" : "Refresh"}
            </button>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-[1.4fr_1fr]">
          <div>
            <p className="text-sm text-muted-foreground">{desk.sessionLabel}</p>
            <p className="mt-1 font-display text-xl leading-snug text-foreground">
              {filter === "picks"
                ? mode === "day" && !dayQuery.data
                  ? "Reading the 5-minute tape."
                  : pickHeadline(mode, mode === "day" ? dayVisible.length : visible.length)
                : mode === "day" && dayQuery.data
                  ? dayQuery.data.summary
                  : mode === "day"
                    ? "Reading the 5-minute tape."
                    : desk.summary}
            </p>
            <p className="mt-2 text-sm text-foreground">
              {mode === "day" && dayQuery.data ? dayQuery.data.sessionNote : desk.tape.line}
            </p>
            {mode === "swing" ? (
              <p className="mt-2 text-sm text-muted-foreground">
                {filter === "picks"
                  ? "Same five all session. Buy only through the turn high, not on the average. A headline can still keep it a wait."
                  : `${moverCount} names can move. Quiet stocks are off Can move until you pick All.`}
              </p>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                {clockLine ? `${clockLine} ` : null}
                {filter === "picks"
                  ? "A live day buy ranks first, then the waits with the most pace. Open Can move for the rest."
                  : "A day buy also needs pace of at least 1.1×. Quiet breaks are not buys."}
              </p>
            )}
          </div>
          <dl className="grid grid-cols-3 gap-2">
            <Count label="Buy" value={counts.buy} tone="up" />
            <Count label="Wait" value={counts.wait} tone="ink" />
            <Count label="Pass" value={counts.pass} tone="down" />
          </dl>
        </div>
        {refreshError ? <p className="text-sm text-down">{refreshError}</p> : null}
      </header>

      <div className="sticky top-0 z-10 -mx-4 mt-4 border-b border-border bg-background/95 px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <div className="flex gap-2 overflow-x-auto pb-2">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
              className={cn(
                "h-10 shrink-0 rounded-full px-3 text-sm font-medium transition-colors duration-150 ease-out",
                filter === item.id
                  ? "bg-accent text-accent-foreground"
                  : "bg-card text-foreground ring-1 ring-border",
              )}
            >
              {item.label === "Holding" && mode === "day" ? "In a trade" : item.label}
              {item.id === "hold" && (mode === "day" ? inTrade.length : holds.length) > 0
                ? ` ${mode === "day" ? inTrade.length : holds.length}`
                : ""}
            </button>
          ))}
        </div>
        <div className="mt-2 flex gap-2 overflow-x-auto pb-2">
          {SIZES.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={size === item.id}
              onClick={() => setSize(item.id)}
              className={cn(
                "h-10 shrink-0 rounded-full px-3 text-sm font-medium transition-colors duration-150 ease-out",
                size === item.id
                  ? "bg-foreground text-background"
                  : "text-muted-foreground ring-1 ring-border",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
        <label className="relative mt-1 block">
          <span className="sr-only">Search ticker or company</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Search ticker, company, or industry"
            className="h-11 w-full rounded-sm border border-border bg-card pr-3 pl-9 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
      </div>

      <section className="mt-4 flex flex-col gap-3" aria-label="Decisions">
        {dayLoading ? (
          <p className="rounded-xl bg-card px-4 py-5 text-sm text-muted-foreground ring-1 ring-border">
            Reading 5-minute bars for the liquid names. The opening range and VWAP take a few seconds.
          </p>
        ) : dayError ? (
          <p className="rounded-xl bg-card px-4 py-5 text-sm text-down ring-1 ring-border">{dayError}</p>
        ) : mode === "day" ? (
          dayVisible.length === 0 ? (
            <Empty filter={filter} lookup={lookup} query={q} day />
          ) : (
            dayVisible.map((trade, index) => (
              <DayCard
                key={trade.symbol}
                trade={trade}
                swing={desk.plans.find((plan) => plan.symbol === trade.symbol)}
                inIt={tradeSet.has(trade.symbol)}
                expanded={open === trade.symbol}
                rank={filter === "picks" ? index + 1 : undefined}
                onToggle={() => setOpen((current) => (current === trade.symbol ? null : trade.symbol))}
                onIn={() => toggleTrade(trade.symbol)}
              />
            ))
          )
        ) : visible.length === 0 ? (
          <Empty filter={filter} lookup={lookup} query={q} />
        ) : (
          visible.map((plan, index) => (
            <PlanCard
              key={plan.symbol}
              plan={plan}
              holding={holdSet.has(plan.symbol)}
              expanded={open === plan.symbol}
              rank={filter === "picks" ? index + 1 : undefined}
              onToggle={() => setOpen((current) => (current === plan.symbol ? null : plan.symbol))}
              onHold={() => toggleHold(plan.symbol)}
            />
          ))
        )}
      </section>

      <footer className="mt-10 border-t border-border pt-5 text-sm text-muted-foreground">
        <p>
          The book is {desk.scanned} liquid US names, from small-cap through large-cap. The screen opens on
          five names that can turn. A daily low has to tag the 20-day, and the buy is a trade back through
          that day's high, not the average. {desk.charted} priced today. {desk.qualified.length} still clear
          $300 million and $10. {desk.removed} were removed for size, a penny past, thin dollar volume, a
          parabolic spike, or a missing chart. A buy also needs a typical day of at least 3.5% or a coil,
          a target of at least 1.8, and a clear headline. Do not buy the dip. Day trades still use the
          opening-range high, above VWAP, no new entry after 15:10 ET, and flat by 15:50.
        </p>
        <p className="mt-3">
          Meridian is a mechanical checklist, not a broker and not advice. Prices gap through
          invalidation. You can lose money. Nothing here is an instruction to buy or sell in your
          account.
        </p>
        <p className="mt-3 text-xs">
          Prices from Yahoo Finance daily bars. Market cap is the live price times shares
          outstanding (snapshot 7 Oct 2026). Small-cap is $300 million–$2 billion. Mid-cap is $2–10
          billion. A name drops off under $300 million, under $10, or after a penny print in the past
          year. Read at {new Date(desk.asOf).toLocaleString("en-US", { timeZone: "America/New_York" })} ET.
          The desk caches for ten minutes.
        </p>
      </footer>
    </div>
  );
}

function Count({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "up" | "down" | "ink";
}) {
  return (
    <div className="rounded-md bg-card px-3 py-3 ring-1 ring-border">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "mt-1 font-display text-2xl leading-none tabular-nums",
          tone === "up" && "text-up",
          tone === "down" && "text-down",
          tone === "ink" && "text-foreground",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function PickRank({ n }: { n: number }) {
  return (
    <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-foreground px-1.5 text-xs font-medium text-background tabular-nums">
      {n}
    </span>
  );
}

function pickHeadline(mode: "swing" | "day", shown: number): string {
  if (shown === 0) return mode === "day" ? "No day-trade pick right now." : "No swing pick right now.";
  const noun = shown === 1 ? "name" : "names";
  return mode === "day"
    ? `${shown} ${noun} to pick today. A live buy ranks first.`
    : `${shown} ${noun}. A turn that is live ranks first. Do not buy the dip.`;
}

function nearTrigger(distance: number | null): number {
  if (distance == null) return 99;
  return distance >= 0 ? distance : 40 + Math.abs(distance);
}

function rankSwingPicks(plans: Plan[]): Plan[] {
  const stanceRank = { buy: 0, wait: 1, pass: 2 };
  const eligible = plans.filter((plan) => plan.move !== "steady" && plan.stance !== "pass" && plan.trigger != null);
  const closeEnough = eligible.filter((plan) => {
    const distance = plan.distancePct ?? 99;
    return distance <= 3 && distance >= -1.5;
  });
  const pool = closeEnough.length > 0 ? closeEnough : eligible;
  return [...pool]
    .sort((a, b) => {
      if (stanceRank[a.stance] !== stanceRank[b.stance]) return stanceRank[a.stance] - stanceRank[b.stance];
      return Math.abs(a.distancePct ?? 99) - Math.abs(b.distancePct ?? 99) || b.atrPct - a.atrPct;
    })
    .slice(0, PICK_COUNT);
}

function rankDayPicks(trades: DayTrade[]): DayTrade[] {
  const stanceRank = { buy: 0, wait: 1, pass: 2 };
  const gap = (trade: DayTrade) => {
    if (trade.trigger == null || trade.price <= 0) return 99;
    return nearTrigger(((trade.trigger - trade.price) / trade.price) * 100);
  };
  return trades
    .filter((trade) => trade.travel !== "quiet" && trade.stance !== "pass" && trade.trigger != null)
    .sort((a, b) => {
      if (stanceRank[a.stance] !== stanceRank[b.stance]) return stanceRank[a.stance] - stanceRank[b.stance];
      if (a.stance === "buy") return (b.rr ?? 0) - (a.rr ?? 0) || b.rvol - a.rvol || (b.typicalPct ?? 0) - (a.typicalPct ?? 0);
      return gap(a) - gap(b) || b.rvol - a.rvol || (b.typicalPct ?? 0) - (a.typicalPct ?? 0);
    })
    .slice(0, PICK_COUNT);
}

function lookupMiss(desk: Desk, raw: string): string | null {
  const query = raw.trim().toUpperCase();
  if (!/^[A-Z]{1,5}$/.test(query)) return null;
  if (desk.plans.some((plan) => plan.symbol === query)) return null;
  const rejected = desk.rejected.find((item) => item.symbol === query);
  if (rejected) return `${query} was charted and removed. ${rejected.reason}`;
  if (desk.qualified.includes(query)) {
    return `${query} still clears $300 million, but it did not make the decision list. Search the pass filter, or it was removed — try the ticker again in a moment if prices failed.`;
  }
  return `${query} is not on the desk. Penny stocks, names under $300 million, warrants, and thin promotion-prone tapes are left out.`;
}

function Empty({
  filter,
  lookup,
  query,
  day = false,
}: {
  filter: FilterId;
  lookup: string | null;
  query: string;
  day?: boolean;
}) {
  if (lookup && !day) {
    return (
      <p className="rounded-xl bg-card px-4 py-5 text-sm text-foreground ring-1 ring-border">{lookup}</p>
    );
  }
  const text =
    filter === "buy"
      ? day
        ? "No day buy is armed. Top 5 still lists the closest waits that can travel."
        : "No mover buy is armed. That is a normal day. Top 5 lists the closest waits that can still travel."
      : filter === "picks"
        ? day
          ? "No day-trade pick in this size. Try All sizes, or open Can move."
          : "No swing pick in this size. Try All sizes, or open Can move."
        : filter === "movers"
        ? day
          ? "No name that can move is in this size filter."
          : "No wide-range or coiled name is in this size filter."
        : filter === "hold"
          ? day
            ? "You have not marked a day trade. Open a name and tap “I am in this”."
            : "You have not marked a holding. Open a name and tap “I hold this”."
          : query.trim()
            ? "Nothing in this filter matches that search."
            : "Nothing in this filter today.";
  return (
    <p className="rounded-xl bg-card px-4 py-5 text-sm text-muted-foreground ring-1 ring-border">{text}</p>
  );
}

function DayCard({
  trade,
  swing,
  inIt,
  expanded,
  rank,
  onToggle,
  onIn,
}: {
  trade: DayTrade;
  swing?: Plan;
  inIt: boolean;
  expanded: boolean;
  rank?: number;
  onToggle: () => void;
  onIn: () => void;
}) {
  const call = inIt ? dayPosition(trade) : null;
  return (
    <article className="rounded-xl bg-card p-4 ring-1 ring-border">
      <button type="button" onClick={onToggle} className="w-full text-left" aria-expanded={expanded}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {rank != null ? <PickRank n={rank} /> : null}
              <h2 className="font-display text-xl leading-none">{trade.symbol}</h2>
              <span className="truncate text-sm text-muted-foreground">{trade.name}</span>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {travelLabel(trade.travel)}
              {trade.typicalPct != null ? ` · ${trade.typicalPct}% typical day` : ""}
              {swing ? ` · ${tierLabel(swing.capTier)}` : ""}
              {` · ${trade.rvol.toFixed(1)}× pace`}
              {trade.orHigh != null && trade.orLow != null
                ? ` · ${(((trade.orHigh - trade.orLow) / trade.price) * 100).toFixed(1)}% opening range`
                : ""}
              {` · VWAP ${money(trade.vwap)}`}
            </p>
          </div>
          <StanceMark stance={trade.stance} />
        </div>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="font-display text-2xl leading-none tabular-nums">{money(trade.price)}</p>
          <p className={cn("text-sm tabular-nums", trade.changePct >= 0 ? "text-up" : "text-down")}>
            {signedPct(trade.changePct)}
          </p>
          {swing ? (
            <p className="text-sm text-muted-foreground tabular-nums">{compactCap(swing.marketCap)}</p>
          ) : null}
        </div>
        <p className="mt-3 text-sm text-foreground">{trade.location}</p>
        <dl className="mt-4 grid grid-cols-3 gap-2">
          <Level label="Trigger" value={trade.trigger} tone="ink" />
          <Level label="Invalidation" value={trade.invalidation} tone="down" />
          <Level label="Target" value={trade.target} tone="up" />
        </dl>
      </button>
      <p className="mt-4 border-t border-border pt-3 text-sm font-medium text-foreground">
        {inIt && call ? call.label : trade.flatTitle}
      </p>
      {expanded ? (
        <div className="mt-4 flex flex-col gap-4 border-t border-border pt-4">
          <p className="text-sm text-foreground">{inIt && call ? call.detail : trade.flatDetail}</p>
          <PriceChart plan={trade} intraday vwap={trade.vwap} />
          <p className="text-xs text-muted-foreground">
            5-minute closes. Dashed lines are invalidation, trigger, and target. The dotted line is VWAP.
          </p>
          <p className="text-sm text-foreground">{trade.why}</p>
          <ShareSize trade={trade} />
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
            <Mini label="VWAP" value={money(trade.vwap)} />
            <Mini label="Range high" value={trade.orHigh == null ? "—" : money(trade.orHigh)} />
            <Mini label="Range low" value={trade.orLow == null ? "—" : money(trade.orLow)} />
            <Mini label="Pace" value={`${trade.rvol.toFixed(1)}×`} />
            <Mini label="Risk" value={trade.riskPct == null ? "—" : `${trade.riskPct}%`} />
            <Mini label="Payoff" value={trade.rr == null ? "—" : `${trade.rr.toFixed(1)}×`} />
          </dl>
          <button
            type="button"
            onClick={onIn}
            aria-pressed={inIt}
            className={cn(
              "inline-flex h-11 items-center justify-center gap-2 rounded-sm px-3 text-sm font-medium transition-opacity duration-150 ease-out",
              inIt
                ? "bg-accent text-accent-foreground"
                : "bg-background text-foreground ring-1 ring-border hover:opacity-80",
            )}
          >
            <Bookmark className="size-4" aria-hidden="true" />
            {inIt ? "In this trade" : "I am in this"}
          </button>
        </div>
      ) : null}
    </article>
  );
}

function ShareSize({ trade }: { trade: DayTrade }) {
  const [budget, setBudget] = useState(250);
  const entry = trade.stance === "buy" ? trade.price : trade.trigger;
  if (trade.stance === "pass" || entry == null || trade.invalidation == null || entry <= trade.invalidation) {
    return null;
  }
  const perShare = entry - trade.invalidation;
  const shares = Math.floor(budget / perShare);
  const stock = shares * entry;
  return (
    <div>
      <p className="text-sm text-foreground">
        Size it off the stop. Pick how much you are willing to lose if invalidation fills.
      </p>
      <div className="mt-2 flex gap-2">
        {[100, 250, 500].map((amount) => (
          <button
            key={amount}
            type="button"
            aria-pressed={budget === amount}
            onClick={() => setBudget(amount)}
            className={cn(
              "h-10 rounded-full px-3 text-sm font-medium tabular-nums",
              budget === amount
                ? "bg-foreground text-background"
                : "text-foreground ring-1 ring-border",
            )}
          >
            ${amount}
          </button>
        ))}
      </div>
      <p className="mt-2 text-sm text-foreground">
        {shares < 1
          ? "That amount does not buy a single share against this stop. Skip it, or risk more."
          : `${shares.toLocaleString("en-US")} shares, about ${money(Math.round(stock))} of stock. A filled stop loses about ${money(Math.round(shares * perShare))}.`}
      </p>
    </div>
  );
}

function dayPosition(trade: DayTrade): { label: string; detail: string } {
  if (trade.invalidation != null && trade.price <= trade.invalidation) {
    return {
      label: "Get out",
      detail: `Price is through ${money(trade.invalidation)}. Sell. Do not hold a broken day trade into the close.`,
    };
  }
  if (trade.target != null && trade.price >= trade.target) {
    return {
      label: "Take it",
      detail: `Target ${money(trade.target)} has traded. Sell. Do not invent a higher target for the same opening range.`,
    };
  }
  if (trade.stance === "pass" || trade.target == null || trade.invalidation == null) {
    return {
      label: "Get out",
      detail: "This is not a day-trade long. If you are in it, sell and be flat. Do not carry it overnight.",
    };
  }
  return {
    label: "Stay in, then flat",
    detail: `Hold toward ${money(trade.target)}. Out if price loses ${money(trade.invalidation)}. Be flat by 15:50 ET either way.`,
  };
}

function PlanCard({
  plan,
  holding,
  expanded,
  rank,
  onToggle,
  onHold,
}: {
  plan: Plan;
  holding: boolean;
  expanded: boolean;
  rank?: number;
  onToggle: () => void;
  onHold: () => void;
}) {
  const call = holding ? positionCall(plan) : null;
  return (
    <article className="rounded-xl bg-card p-4 ring-1 ring-border">
      <button type="button" onClick={onToggle} className="w-full text-left" aria-expanded={expanded}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {rank != null ? <PickRank n={rank} /> : null}
              <h2 className="font-display text-xl leading-none">{plan.symbol}</h2>
              <span className="truncate text-sm text-muted-foreground">{plan.name}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{plan.industry}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              {tierLabel(plan.capTier)} · {moveLabel(plan.move)} · {plan.atrPct}% typical day
            </p>
          </div>
          <StanceMark stance={plan.stance} />
        </div>

        <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="font-display text-2xl leading-none tabular-nums">{money(plan.price)}</p>
          <p className={cn("text-sm tabular-nums", plan.changePct >= 0 ? "text-up" : "text-down")}>
            {signedPct(plan.changePct)}
          </p>
          <p className="text-sm text-muted-foreground tabular-nums">{compactCap(plan.marketCap)}</p>
        </div>

        <p className="mt-3 text-sm text-foreground">{plan.location}</p>
        {plan.newsNote ? <p className="mt-2 text-sm text-muted-foreground">{plan.newsNote}</p> : null}

        <dl className="mt-4 grid grid-cols-3 gap-2">
          <Level label="Trigger" value={plan.trigger} tone="ink" />
          <Level label="Invalidation" value={plan.invalidation} tone="down" />
          <Level label="Target" value={plan.target} tone="up" />
        </dl>
      </button>

      <p className="mt-4 border-t border-border pt-3 text-sm font-medium text-foreground">
        {holding && call ? call.label : plan.holdTitle}
      </p>

      {expanded ? (
        <div className="mt-4 flex flex-col gap-4 border-t border-border pt-4">
          <p className="text-sm text-foreground">{holding && call ? call.detail : plan.holdDetail}</p>
          <PriceChart plan={plan} />
          <p className="text-xs text-muted-foreground">
            Dashed lines: invalidation, trigger, target. The solid line is the daily close.
          </p>
          <p className="text-sm text-foreground">{plan.why}</p>
          <p className="text-sm text-foreground">{plan.moveNote}</p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
            <Mini label="RSI" value={String(plan.rsi)} />
            <Mini label="Risk" value={plan.riskPct == null ? "—" : `${plan.riskPct}%`} />
            <Mini label="Payoff" value={plan.rr == null ? "—" : `${plan.rr.toFixed(1)}×`} />
            <Mini label="To target" value={plan.upsidePct == null ? "—" : `${plan.upsidePct}%`} />
            <Mini
              label="Distance"
              value={plan.distancePct == null ? "—" : `${plan.distancePct > 0 ? "+" : ""}${plan.distancePct}%`}
            />
            <Mini label="20-day" value={money(plan.sma20)} />
            <Mini label="50-day" value={money(plan.sma50)} />
            <Mini label="200-day" value={money(plan.sma200)} />
          </dl>
          <button
            type="button"
            onClick={onHold}
            aria-pressed={holding}
            className={cn(
              "inline-flex h-11 items-center justify-center gap-2 rounded-sm px-3 text-sm font-medium transition-opacity duration-150 ease-out",
              holding
                ? "bg-accent text-accent-foreground"
                : "bg-background text-foreground ring-1 ring-border hover:opacity-80",
            )}
          >
            <Bookmark className="size-4" aria-hidden="true" />
            {holding ? "Marked as a hold" : "I hold this"}
          </button>
        </div>
      ) : null}
    </article>
  );
}

function StanceMark({ stance }: { stance: Stance }) {
  return (
    <span
      className={cn(
        "inline-flex h-7 shrink-0 items-center rounded-full px-2.5 text-xs font-medium",
        stance === "buy" && "bg-up/10 text-up",
        stance === "wait" && "bg-muted text-foreground",
        stance === "pass" && "bg-down/10 text-down",
      )}
    >
      {stanceLabel(stance)}
    </span>
  );
}

function Level({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | null;
  tone: "ink" | "up" | "down";
}) {
  return (
    <div className="min-w-0 rounded-sm bg-background px-2 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "mt-1 truncate text-sm font-medium tabular-nums",
          tone === "up" && "text-up",
          tone === "down" && "text-down",
          tone === "ink" && "text-foreground",
        )}
      >
        {value == null ? "None" : money(value)}
      </dd>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
