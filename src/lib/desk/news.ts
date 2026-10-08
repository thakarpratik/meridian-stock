const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const BLOCK =
  /earnings?\s+(preview|tomorrow|today|after the bell|before the open)|to report earnings|reports earnings|set to report|downgrad|price target cut|cuts? (its )?(outlook|guidance)|lowers? (its )?(outlook|guidance)|guidance cut|miss(es|ed)? (estimates|expectations)|investigat|lawsuit|securities fraud|SEC (charges|investigation|probe)|bankruptcy|share offering|secondary offering|\bdilut|recall|warning letter|restat|subpoena|trading halt/i;

const GENERIC_NAME =
  /^(healthcare|services|technology|technologies|group|holdings|international|company|corporation|incorporated|industries|systems|financial|capital|global|american|national|energy|health|therapeutics|biosciences|inc|corp|ltd|plc)$/i;

export type HeadlineCheck = {
  blocksBuy: boolean;
  note: string;
};

type Story = {
  title: string;
  publisher?: string;
  providerPublishTime?: number;
  relatedTickers?: string[];
};

export async function checkHeadlines(symbol: string, name: string, now = new Date()): Promise<HeadlineCheck> {
  const stories = await fetchStories(symbol);
  if (stories == null) {
    return {
      blocksBuy: false,
      note: "Headlines did not load. This buy is the chart only, so check the news yourself.",
    };
  }
  const fresh = stories.filter((story) => {
    const at = (story.providerPublishTime ?? 0) * 1000;
    return at > 0 && now.getTime() - at <= WEEK_MS && aboutCompany(story, symbol, name);
  });
  if (fresh.length === 0) {
    return {
      blocksBuy: false,
      note: "No company headline in the last week. The buy is the chart only.",
    };
  }
  const blocking = fresh.find((story) => BLOCK.test(story.title) || earningsSoon(story.title, now));
  const lead = blocking ?? fresh[0]!;
  const when = age(lead, now);
  const who = lead.publisher ? `${lead.publisher}, ${when}` : when;
  if (blocking) {
    return {
      blocksBuy: true,
      note: `Not a buy. ${who}: “${lead.title}”. That kind of headline can gap through the stop.`,
    };
  }
  return {
    blocksBuy: false,
    note: `Headline, ${who}: “${lead.title}”. It is not a downgrade, a guidance cut, a lawsuit, or earnings inside the next week, so the chart buy stands.`,
  };
}

function earningsSoon(title: string, now: Date): boolean {
  if (!/earn|results|to report|reports/i.test(title)) return false;
  const match = title.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})/i,
  );
  if (!match) return false;
  const months = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
  ];
  const when = Date.UTC(Number(match[3]), months.indexOf(match[1]!.toLowerCase()), Number(match[2]));
  const days = (when - now.getTime()) / (24 * 60 * 60 * 1000);
  return days >= -1 && days <= 7;
}

function aboutCompany(story: Story, symbol: string, name: string): boolean {
  const title = story.title;
  if (new RegExp(`\\b${symbol}\\b`, "i").test(title)) return true;
  const word = name.split(/[\s,]+/).find((part) => part.length >= 5 && !GENERIC_NAME.test(part));
  if (word && title.toLowerCase().includes(word.toLowerCase())) return true;
  return false;
}

function age(story: Story, now: Date): string {
  const at = (story.providerPublishTime ?? 0) * 1000;
  const days = Math.floor((now.getTime() - at) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

async function fetchStories(symbol: string): Promise<Story[] | null> {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=8`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": UA },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const json = (await response.json()) as { news?: Story[] };
    return json.news ?? [];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
