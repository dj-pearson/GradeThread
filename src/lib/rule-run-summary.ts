// The toast after a seller presses "Run now" on either rules tab. Pure, so the
// wording is tested once and both tabs say the same thing.

export interface RuleRunOutcome {
  applied?: number;
  errors?: number;
  listings_scanned?: number;
  reason?: string;
}

export interface RuleRunToast {
  kind: "info" | "success" | "warning";
  text: string;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function ruleRunToast(r: RuleRunOutcome, noun = "price change"): RuleRunToast {
  if (r.reason === "already_running") {
    return { kind: "info", text: "A run is already in progress." };
  }
  const applied = r.applied ?? 0;
  const errors = r.errors ?? 0;
  const scanned = r.listings_scanned != null
    ? `Checked ${plural(r.listings_scanned, "listing", "listings")}. `
    : "";
  if (errors > 0) {
    return {
      kind: "warning",
      text: `${scanned}${applied} applied, ${errors} failed, see Activity.`,
    };
  }
  return { kind: "success", text: `${scanned}${plural(applied, noun, `${noun}s`)} applied.` };
}
