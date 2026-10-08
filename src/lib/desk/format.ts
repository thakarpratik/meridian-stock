import type { Plan, Travel } from "./types";

export function money(value: number): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function compactCap(value: number): string {
  if (value >= 1_000_000_000_000) return `$${(value / 1_000_000_000_000).toFixed(2)}T`;
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  return `$${(value / 1_000_000).toFixed(0)}M`;
}

export function signedPct(value: number): string {
  const abs = Math.abs(value).toFixed(2);
  if (value > 0) return `+${abs}%`;
  if (value < 0) return `−${abs}%`;
  return "0.00%";
}

export function stanceLabel(stance: Plan["stance"]): string {
  if (stance === "buy") return "Buy";
  if (stance === "wait") return "Wait";
  return "Pass";
}

export function tierLabel(tier: Plan["capTier"]): string {
  if (tier === "small") return "Small-cap";
  if (tier === "mid") return "Mid-cap";
  return "Large-cap";
}

export function moveLabel(move: Plan["move"]): string {
  if (move === "wide") return "Large range";
  if (move === "coiled") return "Coiled";
  return "Steady";
}

export function travelLabel(travel: Travel): string {
  if (travel === "wide") return "Large range";
  if (travel === "coiled") return "Coiled";
  if (travel === "hot") return "Moving today";
  return "Quiet";
}

export type PositionCall = {
  label: "Hold" | "Exit" | "Take the target";
  detail: string;
};

export function positionCall(plan: Plan): PositionCall {
  if (plan.price <= plan.invalidation) {
    return {
      label: "Exit",
      detail: `Last price is through invalidation at ${money(plan.invalidation)}. The swing is over. Sell. Do not average down.`,
    };
  }
  if (plan.target != null && plan.price >= plan.target) {
    return {
      label: "Take the target",
      detail: `Price has reached ${money(plan.target)}. Sell the swing. Do not invent a higher target in the same plan.`,
    };
  }
  if (plan.stance === "pass" || plan.target == null) {
    return {
      label: "Exit",
      detail: "This name is a pass. If you hold it as a swing, use strength to get out. A close under invalidation makes the exit mandatory.",
    };
  }
  return {
    label: "Hold",
    detail: `Hold toward ${money(plan.target)}. Exit on a daily close below ${money(plan.invalidation)}. Do not add unless a fresh buy is armed.`,
  };
}
