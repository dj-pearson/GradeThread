import { MARKETPLACE_LABELS } from "@/lib/constants";
import type { ListingPlatform } from "@/types/database";
import type { DelistLogEvent } from "@/hooks/use-delist-log";

// US-3452: one sentence per delist-log event, shared by the item page and
// the Record Sale confirmation. Pure, so the sentence is tested once.
//
// The iOS app carries the same table in DelistLogView.swift; a change here
// changes there in the same commit.

export interface DelistLogLine {
  /** "Sold on eBay", "Poshmark ended", ... */
  headline: string;
  /** "14:06, your browser" ... */
  detail: string;
  /** True for the rows the seller still has to act on. */
  open: boolean;
}

function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const ACTOR: Record<DelistLogEvent["actor"], string> = {
  server: "GradeThread",
  browser: "your browser",
  seller: "you",
};

export function delistLogLine(e: DelistLogEvent): DelistLogLine {
  const label = MARKETPLACE_LABELS[e.platform as ListingPlatform] ?? e.platform;
  const when = clock(e.at);
  const by = ACTOR[e.actor];
  switch (e.event) {
    case "sold":
      return { headline: `Sold on ${label}`, detail: when, open: false };
    case "ended_api":
      return { headline: `${label} ended`, detail: `${when}, ${by}`, open: false };
    case "ended_extension":
      return {
        headline: `${label} ended`,
        detail: e.note ? `${when}, ${by}. ${e.note}` : `${when}, ${by}`,
        open: false,
      };
    case "ended_by_hand":
      return { headline: `${label} ended`, detail: `${when}, by you`, open: false };
    case "queued":
      return {
        headline: `${label}: ending from your browser`,
        detail: e.note ? `Queued ${when}. ${e.note}` : `Queued ${when}. Runs when a browser with the extension is open.`,
        open: true,
      };
    case "waiting":
      return {
        headline: `${label}: still live`,
        detail: e.note ?? `Since ${when}. End it yourself, or queue it for your browser.`,
        open: true,
      };
    case "unresolved":
      return {
        headline: `${label}: could not be ended automatically`,
        detail: e.note ? `${when}. ${e.note} End it yourself.` : `${when}. End it yourself.`,
        open: true,
      };
  }
}
