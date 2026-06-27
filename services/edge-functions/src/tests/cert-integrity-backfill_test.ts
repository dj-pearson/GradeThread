// US-490: certificate-integrity backfill unit tests.
//
// Uses an injected in-memory store (the stuck-submissions idiom), so the
// orchestration — batching, idempotency, poisoned-row termination, the
// round-trip with the public verify path, and the share metric split — is
// covered without a DB.
import { assert, assertEquals } from "@std/assert";

// cert-integrity-backfill.ts imports the service-role supabase client at module
// init, so set dummy env BEFORE the dynamic imports (abandoned-checkout idiom).
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { backfillCertificateIntegrity, recordCertificateIntegrityShare } = await import(
  "../lib/cert-integrity-backfill.ts"
);
const { _resetSigningKeyCacheForTest, verifyCertIntegrity, CERT_INTEGRITY_VERSION } =
  await import("../lib/cert-integrity.ts");
import type {
  CertBackfillStore,
  CertIntegrityShare,
  UnsealedCertRow,
} from "../lib/cert-integrity-backfill.ts";
import type { CertIntegrity } from "../lib/cert-integrity.ts";

function row(id: string, overrides: Partial<UnsealedCertRow> = {}): UnsealedCertRow {
  return {
    id,
    certificate_id: `cert-${id}`,
    overall_score: 7.5,
    grade_tier: "Very Good",
    fabric_condition_score: "8.0", // PostgREST numeric-as-string, like a real read
    structural_integrity_score: 7,
    cosmetic_appearance_score: 7.5,
    functional_elements_score: 8,
    odor_cleanliness_score: 9,
    ai_summary: "Light, even wear throughout.",
    buyer_writeup: null, // pre-US-759 legacy rows have no write-up
    ...overrides,
  };
}

// In-memory store: `pending` drains as rows are sealed, like the real query.
function memStore(rows: UnsealedCertRow[]): {
  store: CertBackfillStore;
  sealedRows: Map<string, CertIntegrity>;
} {
  const pending = [...rows];
  const sealedRows = new Map<string, CertIntegrity>();
  const store: CertBackfillStore = {
    findUnsealed: (limit, excludeIds) =>
      Promise.resolve(
        pending.filter((r) => !excludeIds.includes(r.id)).slice(0, limit),
      ),
    seal: (id, integrity) => {
      const idx = pending.findIndex((r) => r.id === id);
      if (idx === -1) return Promise.resolve(false); // already sealed elsewhere
      pending.splice(idx, 1);
      sealedRows.set(id, integrity);
      return Promise.resolve(true);
    },
    countShare: () => Promise.reject(new Error("not used in backfill tests")),
  };
  return { store, sealedRows };
}

Deno.test("backfill seals every certified row missing a hash", async () => {
  _resetSigningKeyCacheForTest();
  Deno.env.set("CERT_SIGNING_KEY", "test-secret");
  try {
    const rows = Array.from({ length: 5 }, (_, i) => row(`r${i}`));
    const { store, sealedRows } = memStore(rows);
    const result = await backfillCertificateIntegrity(store);

    assertEquals(result, { scanned: 5, sealed: 5, failed: 0 });
    assertEquals(sealedRows.size, 5);
    for (const integ of sealedRows.values()) {
      assertEquals(integ.content_hash.length, 64);
      assert(integ.content_signature, "key configured → backfilled rows must be signed");
      assertEquals(integ.integrity_version, CERT_INTEGRITY_VERSION);
    }
  } finally {
    Deno.env.delete("CERT_SIGNING_KEY");
    _resetSigningKeyCacheForTest();
  }
});

Deno.test("backfilled legacy row round-trips through the verify path", async () => {
  _resetSigningKeyCacheForTest();
  Deno.env.set("CERT_SIGNING_KEY", "test-secret");
  try {
    const legacy = row("legacy", { buyer_writeup: null, ai_summary: null });
    const { store, sealedRows } = memStore([legacy]);
    await backfillCertificateIntegrity(store);
    const integ = sealedRows.get("legacy")!;

    // Mirror content-public.ts /certificates/:id/verify exactly: it rebuilds
    // fields from the DB row with `?? ""` for the nullable text columns.
    const verdict = await verifyCertIntegrity(
      {
        certificate_id: legacy.certificate_id,
        overall_score: legacy.overall_score,
        grade_tier: legacy.grade_tier,
        fabric_condition_score: legacy.fabric_condition_score,
        structural_integrity_score: legacy.structural_integrity_score,
        cosmetic_appearance_score: legacy.cosmetic_appearance_score,
        functional_elements_score: legacy.functional_elements_score,
        odor_cleanliness_score: legacy.odor_cleanliness_score,
        ai_summary: legacy.ai_summary ?? "",
        buyer_writeup: legacy.buyer_writeup ?? "",
      },
      integ.content_hash,
      integ.content_signature,
      integ.integrity_version,
    );
    assertEquals(verdict.status, "verified");
    assertEquals(verdict.signed, true);
  } finally {
    Deno.env.delete("CERT_SIGNING_KEY");
    _resetSigningKeyCacheForTest();
  }
});

Deno.test("without a signing key the backfill degrades to hash-only", async () => {
  _resetSigningKeyCacheForTest();
  Deno.env.delete("CERT_SIGNING_KEY");
  const { store, sealedRows } = memStore([row("r1")]);
  const result = await backfillCertificateIntegrity(store);
  assertEquals(result.sealed, 1);
  assertEquals(sealedRows.get("r1")!.content_signature, null);
});

Deno.test("a poisoned row is counted failed once and cannot loop the sweep", async () => {
  _resetSigningKeyCacheForTest();
  Deno.env.delete("CERT_SIGNING_KEY");
  // Non-numeric score → buildCertIntegrity throws → the row stays unsealed and
  // would be re-returned by every findUnsealed page. The seen-set must keep the
  // sweep terminating with the row counted exactly once.
  const poisoned = row("bad", { overall_score: "not-a-number" });
  let fetches = 0;
  const { store, sealedRows } = memStore([poisoned, row("ok")]);
  const counting: CertBackfillStore = {
    ...store,
    findUnsealed: (limit, excludeIds) => {
      fetches += 1;
      return store.findUnsealed(limit, excludeIds);
    },
  };
  const result = await backfillCertificateIntegrity(counting);
  assertEquals(result, { scanned: 2, sealed: 1, failed: 1 });
  assert(sealedRows.has("ok"));
  assert(fetches < 5, `sweep must terminate quickly, made ${fetches} fetches`);
});

Deno.test("a full page of poisoned rows doesn't block the rows behind it", async () => {
  _resetSigningKeyCacheForTest();
  Deno.env.delete("CERT_SIGNING_KEY");
  // 100 poisoned rows fill the entire first page (BATCH_LIMIT). The failed-id
  // exclusion must let page two reach the good row sitting behind them.
  const poisoned = Array.from(
    { length: 100 },
    (_, i) => row(`bad${i}`, { overall_score: "not-a-number" }),
  );
  const { store, sealedRows } = memStore([...poisoned, row("ok")]);
  const result = await backfillCertificateIntegrity(store);
  assertEquals(result, { scanned: 101, sealed: 1, failed: 100 });
  assert(sealedRows.has("ok"), "the row behind the poisoned page must still seal");
});

Deno.test("a row sealed concurrently (seal → false) is not double-counted", async () => {
  _resetSigningKeyCacheForTest();
  Deno.env.delete("CERT_SIGNING_KEY");
  const { store } = memStore([row("r1")]);
  const racing: CertBackfillStore = {
    ...store,
    seal: () => Promise.resolve(false), // grading pipeline won the race
  };
  const result = await backfillCertificateIntegrity(racing);
  assertEquals(result, { scanned: 1, sealed: 0, failed: 0 });
});

Deno.test("share recorder returns the store's signed/hash-only/unverifiable split", async () => {
  const share: CertIntegrityShare = { signed: 7, hash_only: 2, unverifiable: 1, total: 10 };
  const store: CertBackfillStore = {
    findUnsealed: () => Promise.resolve([]),
    seal: () => Promise.resolve(false),
    countShare: () => Promise.resolve(share),
  };
  assertEquals(await recordCertificateIntegrityShare(store), share);
});
