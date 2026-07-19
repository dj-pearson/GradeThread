// US-1094: Garment Passport ownership-claim REDEMPTION flow. Integration test —
// drives a REAL edge server (POST /api/passport/claim) + a service-role Supabase
// client to seed/inspect claim tokens. Env-gated; SKIPs cleanly without a
// fixture, matching the repo's other integration tests (e.g. credit-refund).
//
// Required env:
//   TEST_EDGE_BASE_URL              e.g. http://localhost:8787
//   TEST_SUPABASE_URL               e.g. https://api.gradethread.com
//   TEST_SUPABASE_SERVICE_ROLE_KEY  service-role key (bypasses RLS)
//   TEST_PASSPORT_GARMENT_ID        a garments.id safe to mutate in the test DB
//
// Covers: happy path (200 + ownership_transfer appended + current owner moved),
// invalid token (410), expired token (410), and replay/double-claim (second 410).

import { assert, assertEquals } from "@std/assert";
import { createClient } from "@supabase/supabase-js";
import { requireIntegrationFixtures } from "./integration-required.ts";
import { hashClaimToken } from "../lib/garment-passport.ts";

const BASE = Deno.env.get("TEST_EDGE_BASE_URL");
const URL = Deno.env.get("TEST_SUPABASE_URL");
const KEY = Deno.env.get("TEST_SUPABASE_SERVICE_ROLE_KEY");
const GARMENT_ID = Deno.env.get("TEST_PASSPORT_GARMENT_ID");

const CONFIGURED = Boolean(BASE && URL && KEY && GARMENT_ID);

// US-2038 AC3 (class b): skip locally, but FAIL LOUDLY in a lane that
// declared it would run these — a silent skip and a pass look identical.
const RUN = requireIntegrationFixtures(
  "passport-claim",
  ["TEST_EDGE_BASE_URL", "TEST_SUPABASE_URL", "TEST_SUPABASE_SERVICE_ROLE_KEY", "TEST_PASSPORT_GARMENT_ID"],
  CONFIGURED,
);

function admin() {
  return createClient(URL!, KEY!, { auth: { persistSession: false } });
}

function rawToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Seed a claim-token row directly (service role) so the test owns its lifecycle.
async function seedToken(
  db: ReturnType<typeof admin>,
  raw: string,
  opts: { expiresInMs?: number } = {},
): Promise<string> {
  const expiresAt = new Date(Date.now() + (opts.expiresInMs ?? 3_600_000)).toISOString();
  const { data, error } = await db
    .from("passport_claim_tokens")
    .insert({
      garment_id: GARMENT_ID!,
      token_hash: await hashClaimToken(raw),
      expires_at: expiresAt,
    })
    .select("id")
    .single();
  if (error) throw new Error(`seedToken failed: ${error.message}`);
  return (data as { id: string }).id;
}

async function claim(token: string): Promise<Response> {
  return await fetch(`${BASE}/api/passport/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

async function transferCount(db: ReturnType<typeof admin>): Promise<number> {
  const { count } = await db
    .from("garment_events")
    .select("id", { count: "exact", head: true })
    .eq("garment_id", GARMENT_ID!)
    .eq("event_type", "ownership_transfer");
  return count ?? 0;
}

Deno.test({
  name: "happy path: a valid token transfers ownership and appends the event",
  ignore: !RUN,
  fn: async () => {
    const db = admin();
    const before = await transferCount(db);
    const token = rawToken();
    const id = await seedToken(db, token);

    const res = await claim(token);
    const json = await res.json();
    assertEquals(res.status, 200);
    assert(json.ok === true);
    assert(typeof json.passport_slug === "string" && json.passport_slug.length > 0);

    // A new ownership_transfer event exists, and the token is marked used.
    assertEquals(await transferCount(db), before + 1);
    const { data: row } = await db
      .from("passport_claim_tokens")
      .select("claimed_at, claimed_by_node_id")
      .eq("id", id)
      .single();
    const r = row as { claimed_at: string | null; claimed_by_node_id: string | null };
    assert(r.claimed_at !== null, "token marked claimed");
    assert(r.claimed_by_node_id !== null, "claim recorded the buyer node");

    // The garment now points at the new (pseudonymous buyer) owner node.
    const { data: g } = await db
      .from("garments")
      .select("current_owner_node_id")
      .eq("id", GARMENT_ID!)
      .single();
    assertEquals((g as { current_owner_node_id: string }).current_owner_node_id, r.claimed_by_node_id);
  },
});

Deno.test({
  name: "invalid token → 410",
  ignore: !RUN,
  fn: async () => {
    const res = await claim(rawToken()); // never seeded
    await res.body?.cancel();
    assertEquals(res.status, 410);
  },
});

Deno.test({
  name: "expired token → 410, and is not redeemable",
  ignore: !RUN,
  fn: async () => {
    const db = admin();
    const token = rawToken();
    await seedToken(db, token, { expiresInMs: -1000 }); // already expired
    const res = await claim(token);
    await res.body?.cancel();
    assertEquals(res.status, 410);
  },
});

Deno.test({
  name: "replay: a token can be claimed only once (second → 410)",
  ignore: !RUN,
  fn: async () => {
    const db = admin();
    const token = rawToken();
    await seedToken(db, token);

    const first = await claim(token);
    await first.body?.cancel();
    assertEquals(first.status, 200);

    const second = await claim(token);
    await second.body?.cancel();
    assertEquals(second.status, 410, "replayed token must be rejected");
  },
});
