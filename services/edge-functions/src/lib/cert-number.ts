// PSA-style public certificate number (migration 00307). Short Crockford-base32
// "GT-XXXXXXX" code, UNIQUE on grade_reports.certificate_number, used as the
// plain-text verification key in eBay listings + the /verify lookup page. The
// random certificate_id UUID stays the canonical /cert/<id> URL.

import { supabaseAdmin } from "./supabase.ts";

// Crockford base32 — excludes I, L, O, U to avoid visual ambiguity. 32 divides
// 256 evenly, so `byte % 32` is unbiased.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LEN = 7;

/** A random, unverified "GT-XXXXXXX" code (uniqueness is checked separately). */
export function randomCertNumber(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LEN));
  let code = "";
  for (let i = 0; i < CODE_LEN; i++) code += ALPHABET[(bytes[i] ?? 0) % 32] ?? "0";
  return `GT-${code}`;
}

/** Generate a cert number not already present in grade_reports. */
export async function generateUniqueCertNumber(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = randomCertNumber();
    const { data } = await supabaseAdmin
      .from("grade_reports")
      .select("id")
      .eq("certificate_number", candidate)
      .maybeSingle();
    if (!data) return candidate;
  }
  // Astronomically unlikely fallback: extend with more entropy.
  return `${randomCertNumber()}${randomCertNumber().slice(3, 6)}`;
}

/**
 * Returns the report's existing cert number, or generates + stores one and
 * returns it. Lazy-backfill safety net for any certified report that predates
 * the number column or wasn't backfilled. Returns null if the cert id is unknown.
 */
export async function ensureCertificateNumber(
  certificateId: string,
): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("grade_reports")
    .select("id, certificate_number")
    .eq("certificate_id", certificateId)
    .maybeSingle();
  const row = data as { id: string; certificate_number: string | null } | null;
  if (!row) return null;
  if (row.certificate_number) return row.certificate_number;
  const number = await generateUniqueCertNumber();
  await supabaseAdmin
    .from("grade_reports")
    .update({ certificate_number: number })
    .eq("id", row.id);
  return number;
}

/** Normalize user-typed input for /verify lookups (uppercase, strip spaces +
 * dashes, ensure a single GT- prefix). Mirrors the web lib of the same name. */
export function normalizeCertNumber(input: string): string {
  const cleaned = input.trim().toUpperCase().replace(/[\s-]+/g, "");
  const bare = cleaned.startsWith("GT") ? cleaned.slice(2) : cleaned;
  return `GT-${bare}`;
}
