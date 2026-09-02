import {
  BadgeCheck,
  Code,
  DollarSign,
  Handshake,
  KeyRound,
  Package,
  Plus,
  ScanLine,
  Shield,
  ShieldCheck,
  Stamp,
  type LucideIcon,
} from "lucide-react";
import type { UserUseCase } from "@/types/database";

// US-1118, moved out of src/pages/dashboard.tsx by US-3075.
//
// The quick actions and the Discover cards are per-persona LISTS, and what they
// contain is worth asserting without rendering anything, so they live here and
// the two widgets that render them are just markup.

export interface QuickAction {
  key: string;
  icon: LucideIcon;
  label: string;
  sublabel: string;
  to: string;
}

/** The three things this persona does most, one click away. */
export function quickActionsFor(useCase: UserUseCase | null): QuickAction[] {
  switch (useCase) {
    case "buyer":
      return [
        { key: "scan", icon: ScanLine, label: "Scan a Passport", sublabel: "Check an item before you buy", to: "/scan" },
        { key: "verify", icon: ShieldCheck, label: "Verify a Certificate", sublabel: "Confirm a grade is authentic", to: "/verify" },
        { key: "verified", icon: BadgeCheck, label: "Verified Sellers", sublabel: "Browse trusted sellers", to: "/verified" },
      ];
    case "developer":
      return [
        { key: "keys", icon: KeyRound, label: "API Keys", sublabel: "Create & manage keys", to: "/dashboard/developers" },
        { key: "docs", icon: Code, label: "API Docs", sublabel: "Integrate grading", to: "/developers" },
        { key: "new", icon: Plus, label: "New Submission", sublabel: "Grade a garment", to: "/dashboard/submissions/new" },
      ];
    case "consignment":
      return [
        { key: "new", icon: Plus, label: "New Submission", sublabel: "Grade a garment", to: "/dashboard/submissions/new" },
        { key: "consign", icon: Handshake, label: "Consignment", sublabel: "Consignors & payouts", to: "/dashboard/flipdesk/consignment" },
        { key: "finances", icon: DollarSign, label: "View Finances", sublabel: "Profit & payouts", to: "/dashboard/flipdesk/money?view=finances" },
      ];
    case "seller":
    default:
      return [
        { key: "new", icon: Plus, label: "New Submission", sublabel: "Grade a garment", to: "/dashboard/submissions/new" },
        // US-2537: was /dashboard/inventory/new, which is a <Navigate> redirect
        // to this path, one extra hop on the most-clicked quick action.
        { key: "inventory", icon: Package, label: "Add Inventory Item", sublabel: "Track a new item", to: "/dashboard/flipdesk/intake" },
        { key: "finances", icon: DollarSign, label: "View Finances", sublabel: "Profit & analytics", to: "/dashboard/flipdesk/money?view=finances" },
      ];
  }
}

export interface FeatureCard {
  key: string;
  icon: LucideIcon;
  title: string;
  description: string;
  to: string;
  cta: string;
}

export interface FeatureContext {
  verifiedEnabled: boolean;
  verifiedHandle: string | null;
  passportCount: number;
  latestPassportSlug: string | null;
}

/** Persona-relevant feature entry points: Passports, Verified Seller, Guarantee. */
export function featureCardsFor(
  useCase: UserUseCase | null,
  ctx: FeatureContext,
): FeatureCard[] {
  const verified: FeatureCard = ctx.verifiedEnabled
    ? {
        key: "verified",
        icon: BadgeCheck,
        title: "Verified Seller profile",
        description: ctx.verifiedHandle
          ? `Your public trust profile is live, at @${ctx.verifiedHandle}.`
          : "Your public trust profile is live.",
        to: "/dashboard/flipdesk/verified",
        cta: "Manage profile",
      }
    : {
        key: "verified",
        icon: BadgeCheck,
        title: "Become a Verified Seller",
        description: "Build buyer trust with a public, grade-backed seller profile.",
        to: "/dashboard/flipdesk/verified",
        cta: "Set up",
      };

  const passport: FeatureCard =
    ctx.passportCount > 0 && ctx.latestPassportSlug
      ? {
          key: "passport",
          icon: Stamp,
          title: "Garment Passports",
          description: `${ctx.passportCount} ${ctx.passportCount === 1 ? "passport" : "passports"} created. View a verified provenance timeline.`,
          to: `/passport/${ctx.latestPassportSlug}`,
          cta: "View latest",
        }
      : {
          key: "passport",
          icon: Stamp,
          title: "Garment Passports",
          description: "Every grade creates a public provenance passport for the item.",
          to: "/dashboard/submissions/new",
          cta: "Grade an item",
        };

  const guarantee: FeatureCard = {
    key: "guarantee",
    icon: Shield,
    title: "Buyer Guarantee",
    description: "Grade-accuracy protection that travels with every item you list.",
    to: "/buyer-guarantee",
    cta: "Learn more",
  };

  const buyerGuarantee: FeatureCard = {
    key: "guarantee",
    icon: Shield,
    title: "Buyer Guarantee",
    description:
      "Every GradeThread-graded purchase is backed by our accuracy guarantee.",
    to: "/buyer-guarantee",
    cta: "See coverage",
  };

  switch (useCase) {
    case "buyer":
      return [buyerGuarantee];
    case "developer":
      return [passport];
    case "consignment":
    case "seller":
    default:
      return [verified, passport, guarantee];
  }
}
