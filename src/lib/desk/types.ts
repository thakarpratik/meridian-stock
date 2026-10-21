export type Stance = "buy" | "wait" | "pass";
export type CapTier = "small" | "mid" | "large";
export type MoveKind = "wide" | "coiled" | "steady";
export type Travel = "wide" | "coiled" | "hot" | "quiet";

export type Bar = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

export type Plan = {
  symbol: string;
  name: string;
  industry: string;
  price: number;
  changePct: number;
  marketCap: number;
  capTier: CapTier;
  pe: number | null;
  stance: Stance;
  why: string;
  location: string;
  trigger: number | null;
  invalidation: number;
  target: number | null;
  holdTitle: string;
  holdDetail: string;
  riskPct: number | null;
  rr: number | null;
  /** Room from the live price to the target, in percent. */
  upsidePct: number | null;
  distancePct: number | null;
  rsi: number;
  trend: "up" | "mixed" | "down";
  sma20: number;
  sma50: number;
  sma200: number;
  atrPct: number;
  move: MoveKind;
  moveNote: string;
  spark: { t: number; c: number }[];
  /** Set when a chart buy was checked against the week's headlines. */
  newsNote?: string | null;
  newsBlock?: boolean;
};

export type DayTrade = {
  symbol: string;
  name: string;
  price: number;
  changePct: number;
  stance: Stance;
  why: string;
  location: string;
  trigger: number | null;
  invalidation: number | null;
  target: number | null;
  flatTitle: string;
  flatDetail: string;
  vwap: number;
  orHigh: number | null;
  orLow: number | null;
  rvol: number;
  travel: Travel;
  typicalPct: number | null;
  riskPct: number | null;
  rr: number | null;
  rangeReady: boolean;
  spark: { t: number; c: number }[];
};

export type DayBook = {
  asOf: string;
  sessionNote: string;
  summary: string;
  trades: DayTrade[];
};

export type Reject = {
  symbol: string;
  name: string;
  reason: string;
};

export type Desk = {
  asOf: string;
  sessionLabel: string;
  summary: string;
  tape: {
    price: number;
    changePct: number;
    above200: boolean;
    line: string;
  };
  scanned: number;
  charted: number;
  removed: number;
  qualified: string[];
  plans: Plan[];
  rejected: Reject[];
};
