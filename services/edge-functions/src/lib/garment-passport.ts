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

// ── Opt-in identity reveal (US-1105) ─────────────────────────────────────────
// A passport hop is pseudonymous unless its owner explicitly opts in. The reveal
// is the AND of two independent opt-ins, so it can NEVER leak more than the user
// already chose to make public:
//   1. the per-hop consent flag on the node (`identity_revealed`), AND
//   2. the node is linked to an account (`linked_user_id`) whose GradeThread
//      Verified profile is itself PUBLIC (`verified_enabled` + a handle).
// Turning off either one instantly re-pseudonymizes the hop. The ONLY fields a
// reveal ever surfaces are the user's already-public verified handle + display
// name — never an id, email, or address (US-1090 AC#2).

/** A node's reveal-relevant columns (PII-free: a bool, a timestamp, a uuid). */
export interface RevealableNode {
  identity_revealed?: boolean | null;
  linked_user_id?: string | null;
}

/** The linked user's PUBLIC verified-profile fields (the only thing revealed). */
export interface VerifiedIdentity {
  verified_enabled?: boolean | null;
  verified_handle?: string | null;
  verified_display_name?: string | null;
}

/** What a public surface renders for a revealed hop (or null = stay pseudonymous). */
export interface RevealedIdentity {
  handle: string;
  display_name: string | null;
}

/**
 * Resolve the PUBLIC identity to show for a passport hop, or null to keep it
 * pseudonymous. PURE (no DB / env) so it's the single, unit-tested gate every
 * surface (public passport read, SSR) routes through — a reveal requires BOTH
 * the per-hop consent AND a live public verified profile.
 */
export function effectiveRevealedIdentity(
  node: RevealableNode | null | undefined,
  user: VerifiedIdentity | null | undefined,
): RevealedIdentity | null {
  if (!node?.identity_revealed || !node.linked_user_id) return null;
  if (!user?.verified_enabled) return null;
  const handle = typeof user.verified_handle === "string" ? user.verified_handle.trim() : "";
  if (!handle) return null;
  const dn = typeof user.verified_display_name === "string"
    ? user.verified_display_name.trim()
    : "";
  return { handle, display_name: dn || null };
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

// ── Ownership-claim tokens (US-1094) ─────────────────────────────────────────
// A claim token is a high-entropy secret the seller hands to the buyer (link /
// QR) to transfer the passport. We store only its SHA-256 hash, never the raw
// value — a DB read can't redeem outstanding tokens. These two helpers are the
// PURE crypto core (no DB, no env), so they're unit-tested directly.

/** A fresh URL-safe claim token (32 random bytes → 64 hex chars). */
export function generateClaimToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 hex of a raw claim token — the ONLY form ever persisted (US-1094). */
export async function hashClaimToken(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
