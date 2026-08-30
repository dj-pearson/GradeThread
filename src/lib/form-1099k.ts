import { supabase } from "@/lib/supabase";

// US-2988 — the 1099-K bridge.
//
// The database does the aggregation (migration 00693). This file holds the
// types, the writes, and the pure row-builder that turns a bridge into the
// statement a seller or their accountant reads down.

export interface Form1099k {
  id: string;
  platform: string;
  tax_year: number;
  gross_cents: number;
  payer_name: string | null;
  payer_tin_last4: string | null;
  transaction_count: number | null;
  received_on: string | null;
  notes: string | null;
}

export interface Bridge1099k {
  platform: string;
  tax_year: number;
  from: string;
  to: string;
  form_present: boolean;
  reported_gross_cents: number | null;
  payer_name: string | null;
  payer_tin_last4: string | null;
  reported_transaction_count: number | null;
  computed_gross_cents: number;
  sale_count: number;
  variance_cents: number;
  facilitator_tax_cents: number;
  remitted_tax_cents: number;
  shipping_income_cents: number;
  fees_cents: number;
  shipping_cents: number;
  cogs_cents: number;
  returns_cents: number;
  profit_before_overheads_cents: number;
}

type Rpc = {
  rpc: ((
    fn: "form_1099k_bridge",
    args: { p_platform: string; p_tax_year: number },
  ) => Promise<{ data: Bridge1099k | null; error: { message: string } | null }>) &
    ((
      fn: "platforms_with_sales",
      args: { p_tax_year: number },
    ) => Promise<{
      data: { platform: string; sale_count: number }[] | null;
      error: { message: string } | null;
    }>);
};

export async function fetchBridge(
  platform: string,
  taxYear: number,
): Promise<Bridge1099k> {
  const client = supabase as unknown as Rpc;
  const { data, error } = await client.rpc("form_1099k_bridge", {
    p_platform: platform,
    p_tax_year: taxYear,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No bridge returned");
  return data;
}

export async function fetchPlatformsWithSales(
  taxYear: number,
): Promise<{ platform: string; sale_count: number }[]> {
  const client = supabase as unknown as Rpc;
  const { data, error } = await client.rpc("platforms_with_sales", {
    p_tax_year: taxYear,
  });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function fetchForms(taxYear: number): Promise<Form1099k[]> {
  const { data, error } = await supabase
    .from("form_1099k")
    .select(
      "id, platform, tax_year, gross_cents, payer_name, payer_tin_last4, transaction_count, received_on, notes",
    )
    .eq("tax_year", taxYear)
    .order("platform");
  if (error) throw error;
  return (data ?? []) as Form1099k[];
}

export async function saveForm(
  userId: string,
  form: Omit<Form1099k, "id">,
): Promise<void> {
  const { error } = await supabase
    .from("form_1099k")
    .upsert({ user_id: userId, ...form } as never, {
      onConflict: "user_id,platform,tax_year",
    });
  if (error) throw error;
}

export async function deleteForm(id: string): Promise<void> {
  const { error } = await supabase.from("form_1099k").delete().eq("id", id);
  if (error) throw error;
}

// ── The statement ──────────────────────────────────────────────────────────

export interface BridgeRow {
  key: string;
  label: string;
  /** Signed cents, as the ledger stores them. The chain is an addition. */
  cents: number;
  /** Where the number came from, in the seller's words. */
  source: string;
  kind: "start" | "subtract" | "total" | "variance";
}

/**
 * The bridge as rows, top to bottom.
 *
 * Starts at the number that frightens people -- the figure on the form -- and
 * walks down to what it actually left them, naming the source of every
 * subtraction. That order is the point: a seller who opens this has the 1099-K
 * in their hand, so the statement has to begin where they are.
 */
export function bridgeRows(b: Bridge1099k): BridgeRow[] {
  const rows: BridgeRow[] = [];

  if (b.form_present) {
    rows.push({
      key: "reported",
      label: "What the form says",
      cents: b.reported_gross_cents ?? 0,
      source: b.payer_name
        ? `1099-K from ${b.payer_name}`
        : "The 1099-K you entered",
      kind: "start",
    });
    if (b.variance_cents !== 0) {
      rows.push({
        key: "variance",
        label: "We cannot account for",
        cents: -b.variance_cents,
        source: "See the explanation below",
        kind: "variance",
      });
    }
  }

  rows.push({
    key: "computed",
    label: b.form_present
      ? "What your records add up to"
      : "What your records add up to",
    cents: b.computed_gross_cents,
    source: `${b.sale_count} sale${b.sale_count === 1 ? "" : "s"}: price plus shipping plus sales tax`,
    kind: b.form_present ? "total" : "start",
  });

  // Every subtraction below is already negative in the ledger except the
  // facilitator tax, which is positive there (money that came in and went
  // straight out). Negating it here keeps the column a plain addition.
  if (b.facilitator_tax_cents !== 0) {
    rows.push({
      key: "facilitator_tax",
      label: "Sales tax the marketplace took",
      cents: -b.facilitator_tax_cents,
      source: "Collected from the buyer and paid to the state by the platform. It was never yours.",
      kind: "subtract",
    });
  }
  if (b.remitted_tax_cents !== 0) {
    rows.push({
      key: "remitted_tax",
      label: "Sales tax you paid over",
      cents: b.remitted_tax_cents,
      source: "You collected this and sent it to the state. Schedule C line 23.",
      kind: "subtract",
    });
  }
  if (b.returns_cents !== 0) {
    rows.push({
      key: "returns",
      label: "Refunds and returns",
      cents: b.returns_cents,
      source: "Money you gave back",
      kind: "subtract",
    });
  }
  if (b.fees_cents !== 0) {
    rows.push({
      key: "fees",
      label: "Selling and payment fees",
      cents: b.fees_cents,
      source: "Taken by the platform before you saw it",
      kind: "subtract",
    });
  }
  if (b.shipping_cents !== 0) {
    rows.push({
      key: "shipping",
      label: "Shipping labels you bought",
      cents: b.shipping_cents,
      source: "What it cost to send the items",
      kind: "subtract",
    });
  }
  if (b.cogs_cents !== 0) {
    rows.push({
      key: "cogs",
      label: "What the items cost you",
      cents: b.cogs_cents,
      source: "Purchase price of everything sold. Schedule C Part III.",
      kind: "subtract",
    });
  }

  rows.push({
    key: "profit",
    label: "What these sales left you",
    cents: b.profit_before_overheads_cents,
    source: "Before business-wide running costs, which are not tied to one platform",
    kind: "total",
  });

  return rows;
}

/**
 * Check the rows actually add up.
 *
 * A bridge whose visible arithmetic does not reach its own stated total is
 * worse than no bridge: the seller checks it with a calculator, it fails, and
 * they stop trusting every other number in the app. This is what the screen
 * asserts before it renders.
 */
export function bridgeAddsUp(rows: BridgeRow[]): boolean {
  const start = rows.find((r) => r.kind === "start");
  if (!start) return false;
  const profit = rows[rows.length - 1];
  if (!profit || profit.key !== "profit") return false;
  const middle = rows
    .filter((r) => r !== start && r !== profit && r.key !== "computed")
    .reduce((s, r) => s + r.cents, 0);
  return start.cents + middle === profit.cents;
}

export type VarianceCause = { title: string; body: string };

/**
 * Why the form and the records might disagree, most likely first.
 *
 * Named causes rather than a shrug. A seller told only "there is a $412
 * difference" has no next action; a seller told "the platform counts the order
 * date and we count the sale date, so a late-December order can land either
 * side" knows where to look.
 *
 * The sign matters and changes the list entirely, which is why this takes the
 * variance rather than its magnitude.
 */
export function varianceCauses(b: Bridge1099k): VarianceCause[] {
  if (!b.form_present || b.variance_cents === 0) return [];
  const formHigher = b.variance_cents > 0;
  const causes: VarianceCause[] = [];

  if (formHigher) {
    causes.push({
      title: "Sales the app never saw",
      body: "Anything sold on this platform but never imported here is on their form and not in your records. This is the commonest cause by a distance.",
    });
    causes.push({
      title: "Orders that were cancelled or refunded after payment",
      body: "Some platforms report the original payment in the gross and handle the refund separately, so a cancelled order can still be counted.",
    });
    causes.push({
      title: "A date on the boundary",
      body: "The platform counts the day the buyer paid. We count the sale date. An order placed in the last days of December can fall in different years on the two.",
    });
  } else {
    causes.push({
      title: "Sales recorded here that the platform did not process",
      body: "A sale entered by hand, or one paid outside the platform, is in your records and not on their form.",
    });
    causes.push({
      title: "A date on the boundary",
      body: "An order paid in early January but recorded here in December would be in your total and not on this year's form.",
    });
    causes.push({
      title: "A duplicate",
      body: "The same sale imported twice inflates your side. Worth checking if the difference is close to one sale's value.",
    });
  }

  if (b.reported_transaction_count != null) {
    const diff = b.reported_transaction_count - b.sale_count;
    if (diff !== 0) {
      causes.unshift({
        title:
          diff > 0
            ? `The form counts ${diff} more transaction${diff === 1 ? "" : "s"} than we have sales`
            : `We have ${-diff} more sale${-diff === 1 ? "" : "s"} than the form counts transactions`,
        body: "The transaction count is the fastest way to narrow this down: it tells you whether the difference is missing sales or wrong amounts.",
      });
    }
  }

  return causes;
}
