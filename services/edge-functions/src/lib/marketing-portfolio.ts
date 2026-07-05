// US-1599 / AGENTIC-OS Phase 1 (Module M): the Marketing Portfolio agent's pure
// core. The three marketing engines (content, newsletter, drip) already self-tune
// LOCALLY (newsletter-tuning, drip-optimizer, per-post performance-signals). This
// agent's value is EXCLUSIVELY the cross-engine view no per-engine tuner can see:
//   • audience fatigue — combined send pressure on the shared audience,
//   • topic cannibalization — the blog and the newsletter chasing the same angle,
//   • channel collision — two broadcasts landing on the same day.
// It proposes ENGINE-LEVEL levers only (topic-bank additions, a frequency-cap
// change, pausing a fatiguing sequence) — never an individual send or subscriber.
//
// PURE + fixture-tested. The tool feeds normalized weekly rollups; the per-engine
// analytics stay in their own libs (resist duplicating them here — AGENTIC_OS §3.M).

export type MarketingChannel = "content" | "newsletter" | "drip";

// One channel's week, already rolled up by the tool (prior week for the trend).
export interface ChannelWeek {
  channel: MarketingChannel;
  volume: number; // posts (content) or sends (newsletter/drip) this week
  prior_volume: number;
  engagement_rate: number | null; // 0..1 (CTR / open-or-click rate); null = no data
  prior_engagement_rate: number | null;
  conversions: number | null; // attributed conversions this week (drip mainly)
}

export type Trend = "up" | "flat" | "down" | "unknown";

export interface ChannelScore {
  channel: MarketingChannel;
  volume: number;
  engagement_rate: number | null;
  conversions: number | null;
  trend: Trend; // engagement trend vs the prior week
  note: string;
}

const TREND_BAND = 0.1; // ±10% relative change counts as "flat"

// Score one channel: the trend is the RELATIVE engagement change vs last week.
export function scoreChannel(w: ChannelWeek): ChannelScore {
  let trend: Trend = "unknown";
  if (w.engagement_rate !== null && w.prior_engagement_rate !== null && w.prior_engagement_rate > 0) {
    const rel = (w.engagement_rate - w.prior_engagement_rate) / w.prior_engagement_rate;
    trend = rel > TREND_BAND ? "up" : rel < -TREND_BAND ? "down" : "flat";
  }
  const pct = w.engagement_rate !== null ? `${(w.engagement_rate * 100).toFixed(1)}%` : "n/a";
  return {
    channel: w.channel,
    volume: w.volume,
    engagement_rate: w.engagement_rate,
    conversions: w.conversions,
    trend,
    note: `${w.volume} this week, engagement ${pct} (${trend})`,
  };
}

// ── Cross-channel detectors ───────────────────────────────────────────────────

export interface PortfolioSignal {
  type: "audience_fatigue" | "topic_cannibalization" | "channel_collision";
  detail: string;
  evidence: Record<string, unknown>;
}

// A blog topic and a newsletter angle that share enough keywords are chasing the
// same demand — the two engines cannibalize each other's search/attention.
export interface TopicItem {
  channel: "content" | "newsletter";
  label: string;
  keywords: string[];
}

export const CANNIBALIZATION_MIN_OVERLAP = 0.5; // Jaccard on normalized keywords

function normKeywords(kw: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const k of kw) {
    const t = String(k).toLowerCase().trim();
    if (t.length >= 3) out.add(t);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function detectCannibalization(
  topics: readonly TopicItem[],
  minOverlap = CANNIBALIZATION_MIN_OVERLAP,
): PortfolioSignal[] {
  const content = topics.filter((t) => t.channel === "content").map((t) => ({ t, k: normKeywords(t.keywords) }));
  const news = topics.filter((t) => t.channel === "newsletter").map((t) => ({ t, k: normKeywords(t.keywords) }));
  const out: PortfolioSignal[] = [];
  for (const c of content) {
    for (const n of news) {
      const overlap = jaccard(c.k, n.k);
      if (overlap >= minOverlap) {
        out.push({
          type: "topic_cannibalization",
          detail: `Blog "${c.t.label}" and newsletter "${n.t.label}" overlap ${(overlap * 100).toFixed(0)}% on keywords — pick one owner or differentiate the angle.`,
          evidence: { blog: c.t.label, newsletter: n.t.label, overlap: Number(overlap.toFixed(3)), shared: [...c.k].filter((x) => n.k.has(x)) },
        });
      }
    }
  }
  return out;
}

// Two BROADCAST channels sending on the same day to the shared list collide —
// the per-engine schedulers don't see each other. `sendDays` is keyed by date.
export interface SendDay {
  date: string;
  channels: MarketingChannel[]; // broadcast channels that sent that day
}

export function detectCollision(sendDays: readonly SendDay[]): PortfolioSignal[] {
  const out: PortfolioSignal[] = [];
  for (const d of sendDays) {
    const uniq = [...new Set(d.channels)];
    if (uniq.length >= 2) {
      out.push({
        type: "channel_collision",
        detail: `${uniq.join(" + ")} all broadcast on ${d.date} — stagger them so the audience isn't hit twice in a day.`,
        evidence: { date: d.date, channels: uniq },
      });
    }
  }
  return out;
}

// Combined send pressure vs the coordination cap, OR both audience channels
// declining while volume rises — the signature of list fatigue.
export interface CoordinationStats {
  cap_per_day: number;
  max_observed_per_day: number;
  deferred_or_dropped: number;
}

export function detectFatigue(
  coordination: CoordinationStats,
  channels: readonly ChannelScore[],
): PortfolioSignal[] {
  const out: PortfolioSignal[] = [];
  if (coordination.max_observed_per_day > coordination.cap_per_day) {
    out.push({
      type: "audience_fatigue",
      detail: `Peak ${coordination.max_observed_per_day} marketing sends/day exceeded the cap of ${coordination.cap_per_day} (${coordination.deferred_or_dropped} deferred/dropped) — the audience is over-mailed.`,
      evidence: { ...coordination },
    });
  }
  // Both broadcast channels declining engagement while shipping more = fatigue.
  const audience = channels.filter((c) => c.channel === "newsletter" || c.channel === "drip");
  const decliningVolumeUp = audience.filter((c) => c.trend === "down");
  if (audience.length >= 2 && decliningVolumeUp.length === audience.length) {
    out.push({
      type: "audience_fatigue",
      detail: `Both newsletter and drip engagement fell this week — back off frequency before adding more sends.`,
      evidence: { channels: audience.map((c) => ({ channel: c.channel, trend: c.trend })) },
    });
  }
  return out;
}

// ── Focus ranking + memo ──────────────────────────────────────────────────────

export interface FocusItem {
  rank: number;
  focus: string;
  why: string;
}

// Rank next week's focus: every cross-channel signal first (they're the reason
// this agent exists), then the worst-trending channel. Deterministic.
export function rankFocus(channels: readonly ChannelScore[], signals: readonly PortfolioSignal[]): FocusItem[] {
  const items: Array<{ focus: string; why: string }> = [];
  for (const s of signals) items.push({ focus: s.type, why: s.detail });
  const down = channels.filter((c) => c.trend === "down");
  for (const c of down) items.push({ focus: `revive ${c.channel}`, why: c.note });
  return items.map((it, i) => ({ rank: i + 1, ...it }));
}

export interface MarketingPortfolioMemo {
  summary: string;
  scorecard: ChannelScore[];
  signals: PortfolioSignal[];
  focus: FocusItem[];
  all_clear: boolean;
}

export function assembleMarketingPortfolioMemo(
  weeks: readonly ChannelWeek[],
  topics: readonly TopicItem[],
  sendDays: readonly SendDay[],
  coordination: CoordinationStats,
): MarketingPortfolioMemo {
  const scorecard = weeks.map(scoreChannel);
  const signals = [
    ...detectFatigue(coordination, scorecard),
    ...detectCannibalization(topics),
    ...detectCollision(sendDays),
  ];
  const focus = rankFocus(scorecard, signals);
  const allClear = signals.length === 0;
  const parts = [`${scorecard.length} channel(s) reviewed`];
  if (signals.length) {
    const byType = new Map<string, number>();
    for (const s of signals) byType.set(s.type, (byType.get(s.type) ?? 0) + 1);
    parts.push([...byType.entries()].map(([t, n]) => `${n} ${t}`).join(", "));
  } else {
    parts.push("no cross-channel fatigue, cannibalization, or collisions");
  }
  return { summary: parts.join("; ") + ".", scorecard, signals, focus, all_clear: allClear };
}
