import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { money } from "@/lib/desk/format";

type ChartModel = {
  spark: { t: number; c: number }[];
  price: number;
  invalidation: number | null;
  trigger: number | null;
  target: number | null;
};

export function PriceChart({
  plan,
  intraday = false,
  vwap = null,
}: {
  plan: ChartModel;
  intraday?: boolean;
  vwap?: number | null;
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  const points = plan.spark.map((point) => ({
    ...point,
    label: intraday
      ? new Intl.DateTimeFormat("en-US", {
          hour: "numeric",
          minute: "2-digit",
          timeZone: "America/New_York",
        }).format(point.t)
      : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(point.t),
  }));

  const levels = [plan.invalidation, plan.price, plan.trigger, plan.target, vwap].filter(
    (value): value is number => value != null,
  );
  const min = Math.min(...levels, ...points.map((point) => point.c));
  const max = Math.max(...levels, ...points.map((point) => point.c));
  const pad = (max - min) * 0.08 || 1;

  if (!ready) {
    return <div className="h-52 rounded-sm bg-muted" aria-hidden="true" />;
  }

  return (
    <div className="h-52 w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--color-border)" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            minTickGap={28}
          />
          <YAxis
            domain={[min - pad, max + pad]}
            tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={(value: number) => {
              const span = max - min;
              if (span < 2) return `$${value.toFixed(2)}`;
              if (span < 20) return `$${value.toFixed(1)}`;
              return `$${Math.round(value)}`;
            }}
          />
          <Tooltip
            contentStyle={{
              background: "var(--color-card)",
              border: "1px solid var(--color-border)",
              borderRadius: 8,
              color: "var(--color-foreground)",
              fontSize: 12,
            }}
            formatter={(value) => [money(Number(value)), "Close"]}
          />
          {plan.invalidation != null ? (
            <ReferenceLine y={plan.invalidation} stroke="var(--color-down)" strokeDasharray="4 4" />
          ) : null}
          {vwap != null ? (
            <ReferenceLine y={vwap} stroke="var(--color-muted-foreground)" strokeDasharray="1 3" />
          ) : null}
          {plan.trigger != null ? (
            <ReferenceLine y={plan.trigger} stroke="var(--color-accent)" strokeDasharray="2 3" />
          ) : null}
          {plan.target != null ? (
            <ReferenceLine y={plan.target} stroke="var(--color-up)" strokeDasharray="4 4" />
          ) : null}
          <Line
            type="monotone"
            dataKey="c"
            stroke="var(--color-foreground)"
            strokeWidth={1.75}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
