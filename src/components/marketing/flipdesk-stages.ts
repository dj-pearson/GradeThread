import { Award, BarChart3, Boxes, Gauge, Layers, Tag } from "lucide-react";
import type { LucideIcon } from "lucide-react";

// US-1949: the FlipDesk reseller pipeline stages, shared so the animated landing
// hero section and the static /for-resellers preview render the exact same
// source→grade→list→reprice→reconcile flow. Data-only module (no components) so
// it can be imported anywhere without tripping react-refresh.

export interface FlipdeskStage {
  icon: LucideIcon;
  title: string;
  description: string;
  /** Short, illustrative UI lines — a stylized mock, never a real screenshot. */
  mock: string[];
}

export const FLIPDESK_STAGES: readonly FlipdeskStage[] = [
  {
    icon: Boxes,
    title: "Source & scout",
    description:
      "Log thrift hauls, estate sales, and auction lots — and let ScoutAI pull real sold comps so you only buy what flips.",
    mock: ["Sourced 42 items", "ScoutAI comps ✓", "Est. margin +38%"],
  },
  {
    icon: Award,
    title: "Grade for trust",
    description:
      "Send items straight to GradeThread and attach a verified grade, certificate, and Garment Passport.",
    mock: ["Grade 9.0 · NWOT", "Certificate issued", "Passport linked"],
  },
  {
    icon: Layers,
    title: "AutoLister",
    description:
      "Turn photos into ready-to-publish, AI-written listings in bulk, then time launches with scheduled drops.",
    mock: ["37 photos → 12 drafts", "AI titles written", "Scheduled 6:00pm"],
  },
  {
    icon: Tag,
    title: "List & cross-list",
    description:
      "Compose eBay-ready titles, descriptions, and item specifics with a live preview, and cross-list to more channels.",
    mock: ["eBay · Poshmark", "Item specifics ✓", "Live preview"],
  },
  {
    icon: Gauge,
    title: "Reprice automatically",
    description:
      "Repricing rules and bulk pricing keep prices moving toward a sale without manual edits.",
    mock: ["Rule: −5% / 14 days", "18 prices updated", "3 sales triggered"],
  },
  {
    icon: BarChart3,
    title: "Reconcile profit",
    description:
      "Track payouts, fees, per-item P&L, and consignor splits so you always know your real margins.",
    mock: ["Payout $1,284", "Fees reconciled", "Net P&L +$612"],
  },
];
