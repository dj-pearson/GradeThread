// US-348: the public certificate surface must expose ONLY public-safe columns.
//
// Anonymous certificate viewers must never see anti-fraud / internal signals
// (image_authenticity.tells, per_image_analysis, detailed_notes, the raw
// confidence_score, content_signature/content_hash, needs_human_review). After
// migration 00082 the broad "certificate_id IS NOT NULL" SELECT-* policy on
// grade_reports is gone and the data is served by the column-restricted
// `public_grade_reports` view.
//
// This drives a REAL self-hosted Supabase with the ANON key, so it is env-gated
// and SKIPs cleanly when the fixture isn't configured. Required env:
//   TEST_SUPABASE_URL          e.g. https://api.gradethread.com
//   TEST_SUPABASE_ANON_KEY     the public anon key
//   TEST_PUBLIC_CERTIFICATE_ID a certificate_id of an existing certified report
//
// Run:  deno task test   (or: deno test --allow-net --allow-env)

import { assert } from "@std/assert";
import { createClient } from "@supabase/supabase-js";
import { requireIntegrationFixtures } from "./integration-required.ts";

const URL = Deno.env.get("TEST_SUPABASE_URL");
const ANON = Deno.env.get("TEST_SUPABASE_ANON_KEY");
const CERT_ID = Deno.env.get("TEST_PUBLIC_CERTIFICATE_ID");

const CONFIGURED = Boolean(URL && ANON && CERT_ID);

// US-2038 AC3 (class b): skip locally, but FAIL LOUDLY in a lane that
// declared it would run these — a silent skip and a pass look identical.
const RUN = requireIntegrationFixtures(
  "public-certificate",
  ["TEST_SUPABASE_URL", "TEST_SUPABASE_ANON_KEY", "TEST_PUBLIC_CERTIFICATE_ID"],
  CONFIGURED,
);

// Columns that must NEVER reach an anonymous viewer.
const FORBIDDEN_PUBLIC_FIELDS = [
  "confidence_score",
  "needs_human_review",
  "detailed_notes",
  "per_image_analysis",
  "image_authenticity", // raw object (carries `tells`); only derived booleans are public
  "content_signature",
  "content_hash",
  "integrity_version",
  "intentional_misread",
  "prompt_version",
  "adjusted_fabric_condition",
];

function anonClient() {
  return createClient(URL!, ANON!, { auth: { persistSession: false } });
}

Deno.test({
  name: "anon select('*') on grade_reports by certificate_id leaks nothing",
  ignore: !RUN,
  fn: async () => {
    const supabase = anonClient();
    const { data, error } = await supabase
      .from("grade_reports")
      .select("*")
      .eq("certificate_id", CERT_ID!);

    // The broad public policy is gone: anon must get an empty result (RLS
    // deny-by-default) — never the certified row, and never an error that
    // would still carry data. A populated row here is a FAIL.
    assert(!error || data === null, `unexpected error shape: ${error?.message}`);
    assert(
      !data || data.length === 0,
      "anon must NOT read base grade_reports rows; the broad public RLS policy " +
        "must be removed (US-348)",
    );
  },
});

Deno.test({
  name: "anon CAN read the public_grade_reports view",
  ignore: !RUN,
  fn: async () => {
    const supabase = anonClient();
    const { data, error } = await supabase
      .from("public_grade_reports")
      .select("*")
      .eq("certificate_id", CERT_ID!)
      .single();

    assert(!error, `view read should succeed for anon: ${error?.message}`);
    assert(data, "expected the certified report via the public view");
    assert(
      typeof data.overall_score === "number" && typeof data.grade_tier === "string",
      "public view must still carry the buyer-facing grade fields",
    );
    assert(
      typeof data.confidence_label === "string",
      "public view exposes a coarse confidence_label, not the raw score",
    );
  },
});

Deno.test({
  name: "public view row carries no anti-fraud / internal fields",
  ignore: !RUN,
  fn: async () => {
    const supabase = anonClient();
    const { data, error } = await supabase
      .from("public_grade_reports")
      .select("*")
      .eq("certificate_id", CERT_ID!)
      .single();

    assert(!error && data, `view read failed: ${error?.message}`);
    const leaked = FORBIDDEN_PUBLIC_FIELDS.filter((f) =>
      Object.prototype.hasOwnProperty.call(data, f)
    );
    assert(
      leaked.length === 0,
      `public_grade_reports leaks forbidden field(s): ${leaked.join(", ")}`,
    );
  },
});
