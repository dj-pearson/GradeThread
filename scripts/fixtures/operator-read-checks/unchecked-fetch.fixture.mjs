// FIXTURE, not a script. See drops-supabase-error.fixture.mjs for why this
// directory exists. Do NOT "fix" the bad cases below.

const URL_BASE = "https://example.invalid";

/** BAD: the response is never tested. A 401 is parsed as an empty result. */
export async function readWithoutCheckingOk() {
  const res = await fetch(`${URL_BASE}/rest/v1/style_code_names?select=name`); // MUST_FIRE unchecked-fetch-response
  const rows = await res.json().catch(() => []);
  return rows;
}

/** BAD: bound, used, never tested. */
export async function probeWithoutCheckingStatus() {
  const probe = await fetch(`${URL_BASE}/health`); // MUST_FIRE unchecked-fetch-response
  return probe.headers.get("content-type");
}

/** GOOD: `.ok` is tested. */
export async function readCheckingOk() {
  const res = await fetch(`${URL_BASE}/rest/v1/brand_knowledge?select=brand_key`); // MUST_NOT_FIRE
  if (!res.ok) throw new Error(`${res.status} on brand_knowledge`);
  return res.json();
}

/** GOOD: `.status` is tested instead of `.ok`. */
export async function readCheckingStatus() {
  const res = await fetch(`${URL_BASE}/rest/v1/brand_colorways?select=hex`); // MUST_NOT_FIRE
  if (res.status !== 200) return null;
  return res.json();
}
