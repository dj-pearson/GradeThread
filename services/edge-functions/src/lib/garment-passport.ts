// Garment Passport privacy model (US-1090).
//
// The passport (US-1089) is PSEUDONYMOUS BY DEFAULT — `owner_nodes` hold no PII,
// only a stable display label and an enum kind. Real-identity linkage
// (`owner_nodes.linked_user_id`) is OPT-IN and deferred to US-1105. This module
// is the small, PURE, unit-tested core of that posture:
//
//   • pseudonymousLabel() — the only label kind any PUBLIC surface may show
//     ("Seller A", "Buyer B", "Owner 2", "System"). Never a user id / email /
//     handle / address (AC#2). isPseudonymousLabel() lets a surface assert that.
//   • minimizeLinkageRef() — when we need to MATCH a transient external
//     identifier (e.g. an eBay order id) to dedupe a sold→bought handoff, we
//     store a SALTED SHA-256 of it, never the raw PII-bearing value (AC#4 /
//     DATA_RETENTION.md). Same input+salt → same hash (dedupe works); the raw
//     value is not recoverable from what we keep.
//
// Tenant-scoping (US-268): the three passport tables are written ONLY by the
// edge service-role client and must be scoped to the workspace owner. garments
// is keyed by `created_by`; events + nodes hang off it. PASSPORT_TENANT_COLUMN
// documents the key the edge API (US-1092) scopes every query by.

export type OwnerNodeKind = "seller" | "buyer" | "system";

/** The passport tables — all tenant-scoped, service-role-write-only. */
export const PASSPORT_TABLES = [
  "garments",
  "owner_nodes",
  "garment_events",
] as const;

/** The tenant key the edge API scopes garment reads/writes by (US-268). */
export const PASSPORT_TENANT_COLUMN = "created_by";

const KIND_PREFIX: Record<Exclude<OwnerNodeKind, "system">, string> = {
  seller: "Seller",
  buyer: "Buyer",
};

/**
 * Spreadsheet-style bijective base-26 label for a chain position: 0→A, 1→B,
 * … 25→Z, 26→AA, 27→AB, …. Stable, ordinal, and carries zero identity.
 */
export function chainLabel(seq: number): string {
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error(`chainLabel: seq must be a non-negative integer, got ${seq}`);
  }
  let n = seq + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * The pseudonymous display label for a node at chain position `seq`. The ONLY
 * label form a public passport surface may render (AC#2). PII-free by
 * construction.
 */
export function pseudonymousLabel(kind: OwnerNodeKind, seq: number): string {
  if (kind === "system") return "System";
  return `${KIND_PREFIX[kind]} ${chainLabel(seq)}`;
}

const PSEUDONYMOUS_RE = /^(Seller|Buyer|Owner) [A-Z]+$/;

/**
 * True when `s` is a safe pseudonymous label (or "System") — i.e. carries no
 * identity. Public surfaces assert this before exposing a label so a PII value
 * (email, handle, "@", address) can never leak through the passport.
 */
export function isPseudonymousLabel(s: string): boolean {
  return s === "System" || PSEUDONYMOUS_RE.test(s);
}

/**
 * Salted SHA-256 (hex) of a transient external linkage identifier, so we can
 * MATCH/dedupe a handoff without retaining the raw, potentially PII-bearing
 * value (AC#4). Deterministic for a given (salt, input); the raw value is not
 * recoverable from the digest. Salt defaults to PASSPORT_LINKAGE_SALT (env) so
 * digests aren't trivially rainbow-tableable across deployments.
 */
export async function minimizeLinkageRef(
  raw: string,
  salt: string = Deno.env.get("PASSPORT_LINKAGE_SALT") ?? "",
): Promise<string> {
  const normalized = raw.trim().toLowerCase();
  const bytes = new TextEncoder().encode(`${salt}:${normalized}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
