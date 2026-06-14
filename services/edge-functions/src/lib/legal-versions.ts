import { supabaseAdmin } from "./supabase.ts";

// US-904: resolve the CURRENT and REQUIRED legal-document versions from the
// `legal_documents` table (the operator-managed source of truth), with the
// historical baseline as a fallback when the table is empty (fresh DB before the
// 00226 seed). The version string is by convention the document's effective date
// (YYYY-MM-DD), so lexical comparison == chronological comparison.
//
// The pure functions (deriveLegalVersionState / needsReacceptance) are unit
// tested in legal-versions_test.ts — AC#5 requires proving a user who hasn't
// re-accepted is NOT silently treated as accepted.

// Baseline = the version every pre-US-904 user accepted. Keep IN SYNC with the
// 00226 seed and LEGAL_VERSIONS in src/lib/constants.ts.
export const FALLBACK_TOS_VERSION = "2026-04-01";
export const FALLBACK_PRIVACY_VERSION = "2026-04-01";

export type LegalDocKind = "tos" | "privacy";

export interface LegalDocRow {
  kind: LegalDocKind;
  version: string;
  effective_date: string;
  requires_reacceptance: boolean;
}

export interface KindVersionInfo {
  // Latest published version — what we stamp on a fresh acceptance and display.
  current: string;
  // Version of the latest doc that demands re-acceptance. A user is "current"
  // only if their recorded acceptance version is >= this.
  requiredSince: string;
}

export interface LegalVersionState {
  tos: KindVersionInfo;
  privacy: KindVersionInfo;
}

export interface AcceptedVersions {
  tos: string | null;
  privacy: string | null;
}

// Newest-first ordering for one kind: effective_date desc, then version desc as a
// stable tiebreak. Pure — operates on whatever rows it's given.
function sortKindDesc(rows: LegalDocRow[]): LegalDocRow[] {
  return [...rows].sort((a, b) => {
    if (a.effective_date !== b.effective_date) {
      return a.effective_date < b.effective_date ? 1 : -1;
    }
    if (a.version !== b.version) return a.version < b.version ? 1 : -1;
    return 0;
  });
}

function deriveKind(
  rows: LegalDocRow[],
  kind: LegalDocKind,
  fallback: string,
): KindVersionInfo {
  const forKind = sortKindDesc(rows.filter((r) => r.kind === kind));
  if (forKind.length === 0) {
    return { current: fallback, requiredSince: fallback };
  }
  const current = forKind[0]!.version;
  // Latest version that forces re-acceptance. If none do (e.g. only minor edits
  // were ever published), the bar is the oldest published version — so brand-new
  // users with no recorded acceptance are still gated, but prior acceptors are
  // never disturbed.
  const forcing = forKind.find((r) => r.requires_reacceptance);
  const requiredSince = forcing
    ? forcing.version
    : forKind[forKind.length - 1]!.version;
  return { current, requiredSince };
}

// Pure: turn a flat list of document rows into the per-kind version state.
export function deriveLegalVersionState(rows: LegalDocRow[]): LegalVersionState {
  return {
    tos: deriveKind(rows, "tos", FALLBACK_TOS_VERSION),
    privacy: deriveKind(rows, "privacy", FALLBACK_PRIVACY_VERSION),
  };
}

// Pure: does this user need to (re-)accept? A NULL recorded version always
// needs acceptance; otherwise the recorded version must be >= the required bar.
// Crucially this never "silently accepts" a stale/missing version (AC#5).
function meetsBar(accepted: string | null, requiredSince: string): boolean {
  if (!accepted) return false;
  return accepted >= requiredSince;
}

export function needsReacceptance(
  state: LegalVersionState,
  accepted: AcceptedVersions,
): boolean {
  return (
    !meetsBar(accepted.tos, state.tos.requiredSince) ||
    !meetsBar(accepted.privacy, state.privacy.requiredSince)
  );
}

// DB loader: read every published document and derive the version state. Falls
// back to the baseline on a read error so the gate fails safe (still enforces
// the historical version rather than letting everyone through).
export async function loadLegalVersionState(): Promise<LegalVersionState> {
  const { data, error } = await supabaseAdmin
    .from("legal_documents")
    .select("kind, version, effective_date, requires_reacceptance");
  if (error) {
    console.error("[legal-versions] read failed:", error.message);
    return deriveLegalVersionState([]);
  }
  return deriveLegalVersionState((data ?? []) as unknown as LegalDocRow[]);
}
