import { supabase } from "@/lib/supabase";

// US-2982 — the tax profile, and the pure date maths that reads it.
//
// Everything downstream in the Books and Taxes epic (US-2981) needs to know
// what "this year" means before it can compute anything, and until now
// finances.tsx assumed January. A seller on a fiscal year that starts in July
// was shown the wrong twelve months with no indication anything was wrong,
// which is the worst kind of wrong: confidently, quietly, every time.
//
// The period helpers live here rather than in the page so they are unit-tested
// without rendering anything. They are pure: no Date.now() inside, the caller
// passes the reference date.

export const ENTITY_TYPES = [
  "sole_prop",
  "single_member_llc",
  "multi_member_llc",
  "partnership",
  "s_corp",
  "c_corp",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  sole_prop: "Sole proprietor",
  single_member_llc: "LLC, just me",
  multi_member_llc: "LLC, more than one owner",
  partnership: "Partnership",
  s_corp: "S corporation",
  c_corp: "C corporation",
};

// What each entity means for the seller, in a sentence, at the reading level
// the rest of the product uses. Shown beside the choice rather than hidden in a
// tooltip: this is the field people get wrong, and getting it wrong changes the
// self-employment tax figure US-2991 shows them.
export const ENTITY_TYPE_HELP: Record<EntityType, string> = {
  sole_prop:
    "You sell under your own name and file a Schedule C with your personal return. This is most resellers.",
  single_member_llc:
    "You set up an LLC on your own. For federal tax this usually works the same as a sole proprietor: still Schedule C.",
  multi_member_llc:
    "An LLC with more than one owner. This normally files a partnership return, not a Schedule C.",
  partnership:
    "Two or more owners sharing the business. Files its own return and passes profit through to each owner.",
  s_corp:
    "You elected S corporation treatment. You pay yourself a wage and the profit is handled separately.",
  c_corp:
    "The business is taxed on its own, separately from you. Rare for a reseller.",
};

/** Entities whose profit lands on a Schedule C, which is what most of the epic assumes. */
export const SCHEDULE_C_ENTITIES: readonly EntityType[] = [
  "sole_prop",
  "single_member_llc",
];

export const ACCOUNTING_METHODS = ["cash", "accrual"] as const;
export type AccountingMethod = (typeof ACCOUNTING_METHODS)[number];

export const ACCOUNTING_METHOD_LABELS: Record<AccountingMethod, string> = {
  cash: "Cash",
  accrual: "Accrual",
};

export const ACCOUNTING_METHOD_HELP: Record<AccountingMethod, string> = {
  cash: "Money counts on the day it moves. A sale counts when you get paid. Almost every reseller uses this.",
  accrual:
    "Money counts on the day it is earned or owed, even if it has not moved yet.",
};

export const FILING_STATUSES = [
  "single",
  "married_joint",
  "married_separate",
  "head_of_household",
  "qualifying_surviving_spouse",
] as const;
export type FilingStatus = (typeof FILING_STATUSES)[number];

export const FILING_STATUS_LABELS: Record<FilingStatus, string> = {
  single: "Single",
  married_joint: "Married, filing together",
  married_separate: "Married, filing separately",
  head_of_household: "Head of household",
  qualifying_surviving_spouse: "Qualifying surviving spouse",
};

export const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI",
  "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN",
  "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH",
  "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA",
  "WV", "WI", "WY",
] as const;

export interface TaxProfile {
  id: string;
  user_id: string;
  entity_type: EntityType;
  accounting_method: AccountingMethod;
  fiscal_year_start_month: number;
  filing_state: string | null;
  filing_status: FilingStatus;
  business_started_on: string | null;
  has_ein: boolean;
  other_household_income_cents: number | null;
  created_at: string;
  updated_at: string;
}

/** The row a seller who never opens the settings screen is treated as having. */
export type TaxProfileDefaults = Omit<
  TaxProfile,
  "id" | "user_id" | "created_at" | "updated_at"
>;

// Explicit, not implied. A blank screen asks the seller to make five decisions
// before they can see a number; these defaults are the correct answer for the
// overwhelmingly common case, so the screen can show real figures on the first
// visit and the seller only touches what differs.
export const TAX_PROFILE_DEFAULTS: TaxProfileDefaults = {
  entity_type: "sole_prop",
  accounting_method: "cash",
  fiscal_year_start_month: 1,
  filing_state: null,
  filing_status: "single",
  business_started_on: null,
  has_ein: false,
  other_household_income_cents: null,
};

// ── Money at the form boundary ─────────────────────────────────────────────
//
// The row stores integer cents (US-2984's convention, adopted here first). The
// input holds whatever a person typed. These two functions are the only place
// the two representations meet, so the rounding happens once and is tested.

export function centsToDollarInput(cents: number | null): string {
  if (cents == null) return "";
  return (cents / 100).toFixed(2);
}

/**
 * Dollars typed by a human to integer cents, or null for blank.
 *
 * Returns null rather than 0 for anything unparseable. Zero is a real answer
 * ("I have no other income") and silently turning a typo into it would change
 * the seller's estimated tax without telling them.
 */
export function dollarInputToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export interface TaxProfileChange {
  id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  changed_at: string;
}

/**
 * The profile, or the defaults if the seller has never saved one.
 *
 * Returning defaults rather than null is the point: every caller downstream
 * wants a fiscal year and an accounting method, and forcing each of them to
 * handle "no row yet" is how one of them ends up assuming January again.
 */
export async function fetchTaxProfile(): Promise<
  TaxProfile | TaxProfileDefaults
> {
  const { data, error } = await supabase
    .from("tax_profiles")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as TaxProfile | null) ?? TAX_PROFILE_DEFAULTS;
}

export async function saveTaxProfile(
  userId: string,
  patch: Partial<TaxProfileDefaults>,
): Promise<void> {
  const { error } = await supabase
    .from("tax_profiles")
    .upsert(
      { user_id: userId, ...TAX_PROFILE_DEFAULTS, ...patch } as never,
      { onConflict: "user_id" },
    );
  if (error) throw error;
}

export async function fetchTaxProfileChanges(): Promise<TaxProfileChange[]> {
  const { data, error } = await supabase
    .from("tax_profile_changes")
    .select("id, field, old_value, new_value, changed_at")
    .order("changed_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as TaxProfileChange[];
}

// ── Fiscal period maths ────────────────────────────────────────────────────
//
// All of it in UTC-free local terms on purpose. A fiscal year boundary is a
// calendar fact for the seller sitting in their own timezone, not an instant;
// building it out of Date.UTC would shift a July-1 year start to June 30 for
// anyone west of Greenwich, which is exactly the shape of US-2339's Android
// date bug.

/**
 * The label for the fiscal year containing `on`.
 *
 * A year starting in January is just "2026". A year starting any other month
 * spans two calendar years and is written "2026-27", because calling it "2026"
 * when it ends in June 2027 is how a seller files the wrong twelve months.
 */
export function fiscalYearLabel(on: Date, startMonth: number): string {
  const start = fiscalYearStart(on, startMonth);
  const y = start.getFullYear();
  if (startMonth === 1) return String(y);
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}

/** First day of the fiscal year containing `on`. Local midnight. */
export function fiscalYearStart(on: Date, startMonth: number): Date {
  const m = clampMonth(startMonth);
  const year = on.getMonth() + 1 >= m ? on.getFullYear() : on.getFullYear() - 1;
  return new Date(year, m - 1, 1, 0, 0, 0, 0);
}

/** First instant AFTER the fiscal year containing `on`. Half-open, like every range here. */
export function fiscalYearEnd(on: Date, startMonth: number): Date {
  const start = fiscalYearStart(on, startMonth);
  return new Date(start.getFullYear() + 1, start.getMonth(), 1, 0, 0, 0, 0);
}

/**
 * First day of the fiscal quarter containing `on`.
 *
 * Quarters run from the fiscal year start, not from January. A year starting in
 * July has Q1 = Jul-Sep, and showing that seller a "this quarter" of Jan-Mar is
 * a number that matches nothing they will ever file.
 */
export function fiscalQuarterStart(on: Date, startMonth: number): Date {
  const yearStart = fiscalYearStart(on, startMonth);
  const monthsIn =
    (on.getFullYear() - yearStart.getFullYear()) * 12 +
    (on.getMonth() - yearStart.getMonth());
  const q = Math.floor(monthsIn / 3);
  return new Date(
    yearStart.getFullYear(),
    yearStart.getMonth() + q * 3,
    1,
    0,
    0,
    0,
    0,
  );
}

function clampMonth(m: number): number {
  if (!Number.isFinite(m)) return 1;
  const i = Math.trunc(m);
  if (i < 1) return 1;
  if (i > 12) return 12;
  return i;
}

export type FiscalPeriod =
  | "this_month"
  | "last_30"
  | "this_quarter"
  | "this_year"
  | "all_time";

/**
 * The start instant for a named period, honouring the fiscal year.
 *
 * Returns null for all_time, matching the RPC's "no lower bound" contract.
 */
export function periodStart(
  period: FiscalPeriod,
  startMonth: number,
  now: Date,
): Date | null {
  switch (period) {
    case "this_month":
      return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    case "last_30": {
      const d = new Date(now.getTime());
      d.setDate(d.getDate() - 30);
      return d;
    }
    case "this_quarter":
      return fiscalQuarterStart(now, startMonth);
    case "this_year":
      return fiscalYearStart(now, startMonth);
    case "all_time":
      return null;
  }
}

/** The label a period selector shows, so "This year" can say which year it means. */
export function periodLabel(
  period: FiscalPeriod,
  startMonth: number,
  now: Date,
): string {
  switch (period) {
    case "this_month":
      return "This month";
    case "last_30":
      return "Last 30 days";
    case "this_quarter":
      return startMonth === 1 ? "This quarter" : "This quarter (tax year)";
    case "this_year":
      return startMonth === 1
        ? "This year"
        : `Tax year ${fiscalYearLabel(now, startMonth)}`;
    case "all_time":
      return "All time";
  }
}
