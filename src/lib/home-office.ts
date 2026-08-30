import { supabase } from "@/lib/supabase";

// US-2990 — the simplified home-office deduction.
//
// Square feet times a rate, capped, prorated by months used. The complicated
// version (Form 8829, actual expenses, depreciation recapture on sale) is
// deliberately not built: it needs mortgage interest, insurance, utilities and
// a basis calculation, and getting it wrong is worse than not offering it.
//
// It is SCHEDULE C LINE 30, which the form keeps separate from line 28. See
// src/lib/pnl-statement.ts for what that means to the subtotal chain.

export interface HomeOfficeRate {
  cents_per_sq_ft: number;
  max_sq_ft: number;
  is_provisional: boolean;
  note: string;
}

export interface HomeOfficeYear {
  id?: string;
  tax_year: number;
  square_feet: number;
  months_used: number;
  method: "simplified" | "actual";
}

export interface HomeOfficeOverlap {
  tax_year: number;
  has_home_office: boolean;
  method: string | null;
  square_feet: number | null;
  deduction_cents: number;
  rent_cents: number;
  rent_entries: number;
  utilities_cents: number;
  utilities_entries: number;
  overlaps: boolean;
}

type Rpc = {
  rpc: (
    fn: "home_office_overlap",
    args: { p_tax_year: number },
  ) => Promise<{ data: HomeOfficeOverlap | null; error: { message: string } | null }>;
};

export async function fetchOverlap(taxYear: number): Promise<HomeOfficeOverlap> {
  const client = supabase as unknown as Rpc;
  const { data, error } = await client.rpc("home_office_overlap", {
    p_tax_year: taxYear,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No overlap result returned");
  return data;
}

export async function fetchHomeOfficeYear(
  taxYear: number,
): Promise<HomeOfficeYear | null> {
  const { data, error } = await supabase
    .from("home_office_years")
    .select("id, tax_year, square_feet, months_used, method")
    .eq("tax_year", taxYear)
    .maybeSingle();
  if (error) throw error;
  return (data as HomeOfficeYear | null) ?? null;
}

export async function saveHomeOfficeYear(
  userId: string,
  year: HomeOfficeYear,
): Promise<void> {
  const { error } = await supabase
    .from("home_office_years")
    .upsert({ user_id: userId, ...year } as never, {
      onConflict: "user_id,tax_year",
    });
  if (error) throw error;
}

export async function fetchHomeOfficeRate(): Promise<HomeOfficeRate | null> {
  const { data, error } = await supabase
    .from("home_office_rates")
    .select("cents_per_sq_ft, max_sq_ft, is_provisional, note")
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as HomeOfficeRate | null) ?? null;
}

// ── The arithmetic ─────────────────────────────────────────────────────────

/**
 * The deduction, in whole cents. Mirrors home_office_deduction_cents() in
 * migration 00697 so the screen can show the figure as the seller types,
 * without a round trip per keystroke.
 *
 * THE CAP APPLIES TO THE FOOTAGE, THEN THE MONTHS ARE PRORATED. 400 sq ft for
 * six months is 300 capped and then halved -- $750. Prorating first and capping
 * after gives $1,000. Both look plausible; the difference is $250 on a $1,500
 * maximum, and the order is the whole of it.
 */
export function homeOfficeDeductionCents(
  squareFeet: number,
  monthsUsed: number,
  rate: HomeOfficeRate,
): number {
  if (!(squareFeet > 0)) return 0;
  const months = Math.max(0, Math.min(monthsUsed, 12));
  const cappedFeet = Math.min(squareFeet, rate.max_sq_ft);
  return Math.round((cappedFeet * rate.cents_per_sq_ft * months) / 12);
}

/** "$5.00 a square foot, up to 300 square feet" */
export function describeRate(rate: HomeOfficeRate): string {
  return `$${(rate.cents_per_sq_ft / 100).toFixed(2)} a square foot, up to ${rate.max_sq_ft} square feet`;
}

/** The most this method can ever give, for the "you are at the cap" message. */
export function maxDeductionCents(rate: HomeOfficeRate): number {
  return rate.cents_per_sq_ft * rate.max_sq_ft;
}

export type HomeOfficeNotice =
  | { kind: "at_cap"; text: string }
  | { kind: "overlap"; text: string }
  | { kind: "actual_method"; text: string };

/**
 * What the screen has to say about a figure before a seller files on it.
 *
 * The overlap one is AC3 and it is the reason this function exists: the
 * simplified method REPLACES the rent and utilities you would otherwise
 * apportion, so claiming it alongside rent expensed separately deducts the same
 * space twice -- and neither figure looks wrong on its own.
 *
 * It REPORTS rather than decides. A seller with a home office and a genuinely
 * separate storage unit is perfectly fine, and the app cannot tell that apart
 * from double-counting. The seller can, once both numbers are in front of them.
 */
export function homeOfficeNotices(
  overlap: HomeOfficeOverlap,
  rate: HomeOfficeRate | null,
): HomeOfficeNotice[] {
  const out: HomeOfficeNotice[] = [];

  if (overlap.method === "actual") {
    out.push({
      kind: "actual_method",
      text:
        "You are claiming actual expenses, which needs Form 8829 and a share of your mortgage or rent, insurance, utilities and depreciation. We do not work that one out, so nothing here applies to you.",
    });
    return out;
  }

  if (rate && overlap.deduction_cents >= maxDeductionCents(rate)) {
    out.push({
      kind: "at_cap",
      text: `You are at the ${rate.max_sq_ft} square foot cap, so this is the most the simplified method gives: $${(maxDeductionCents(rate) / 100).toFixed(2)}. A bigger space does not add to it.`,
    });
  }

  if (overlap.overlaps) {
    const parts: string[] = [];
    if (overlap.rent_entries > 0) {
      parts.push(`$${(overlap.rent_cents / 100).toFixed(2)} of rent or storage`);
    }
    if (overlap.utilities_entries > 0) {
      parts.push(`$${(overlap.utilities_cents / 100).toFixed(2)} of utilities`);
    }
    out.push({
      kind: "overlap",
      text:
        `You are claiming $${(overlap.deduction_cents / 100).toFixed(2)} for the home office and have also expensed ` +
        `${parts.join(" and ")} this year. The simplified method already covers rent and utilities for that space, ` +
        "so if any of that is for the same room, it is being deducted twice. A separate storage unit is fine. Only you can tell which.",
    });
  }

  return out;
}
