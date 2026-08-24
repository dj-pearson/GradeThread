// US-2838: force an RPC response into the shape its readers assume.
//
// Every analytics fetcher in this directory reaches PostgREST through
// `supabase as unknown as RpcClient` and used to end `return data ?? EMPTY_X`.
// The cast means the declared `data: X | null` is an ASSERTION that nothing
// verifies at runtime, and `?? EMPTY_X` only catches null and undefined. Any
// other shape passes straight through wearing the type.
//
// ⚠ WHAT THAT COST, ONCE, ALREADY. `measurement-drift.ts` is read by the
// composer's measurement card. The e2e suite mocks every unmatched
// `/rest/v1/**` call with an empty ARRAY, this RPC included. `[]` is not null,
// so it survived the `??`, and `report.bands.find(...)` threw "Cannot read
// properties of undefined (reading 'find')". A render-phase throw, so the
// ErrorBoundary swallowed the ENTIRE /items/:id/draft route: the seller would
// have seen "Something went wrong" instead of their item, because a measurement
// HINT could not read its cohort bands. Seven sibling libs carried the same
// pattern, including `condition-price-curve.ts`'s `curve.buckets.find(...)` —
// the identical line — on a page no e2e opens.
//
// ── WHY THE TEMPLATE IS THE `EMPTY_X` CONSTANT ──────────────────────────────
//
// Each lib already declares the whole expected shape, with the right types, as
// its `EMPTY_X` default. Deriving the check from that constant means there is
// no second list of field names to drift out of date: add a field to the
// interface, add it to `EMPTY_X` (the compiler already insists), and it is
// checked here for free.
//
// ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
//
// It guarantees the SHAPE, never the VALUES. A number arriving as the string
// "12" still satisfies every check here and still reads as a `number` to
// TypeScript, because nothing at this boundary knows what the values should
// mean. That is a different problem from a missing array, and solving it needs
// a real schema validator rather than a template. Do not read a call to this as
// "the payload was validated".

/** True for a plain object: not null, not an array. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Merge `raw` onto `template`, keeping `template`'s value wherever `raw`'s is
 * the wrong KIND.
 *
 * - `raw` that is not a plain object (null, an array, a scalar) yields the
 *   template untouched. An ARRAY counts as wrong here, deliberately: that is
 *   the exact payload that defeated `?? EMPTY_X`.
 * - A key whose template value is an array keeps the template's array unless
 *   `raw` supplies one too. Elements are NOT inspected — an array of the wrong
 *   element type is the server's answer, not something to patch, and pretending
 *   otherwise would hide a real backend change.
 * - A key whose template value is a plain object recurses, so one level down
 *   (`MeasurementDrift.returns`, which was a real case) is covered.
 * - Keys `raw` carries that the template does not are PRESERVED. They are
 *   outside the contract either way, and dropping them would silently break a
 *   reader using a field its `EMPTY_X` happens not to model.
 */
export function normaliseAgainst<T extends object>(template: T, raw: unknown): T {
  if (!isPlainObject(raw)) return template;

  const out: Record<string, unknown> = { ...template, ...raw };

  for (const [key, tpl] of Object.entries(template)) {
    const v = (raw as Record<string, unknown>)[key];

    // An absent or explicitly-undefined key falls back to the template. The
    // spread above would otherwise let `{ bands: undefined }` win.
    if (v === undefined) {
      out[key] = tpl;
      continue;
    }
    if (Array.isArray(tpl)) {
      out[key] = Array.isArray(v) ? v : tpl;
      continue;
    }
    if (isPlainObject(tpl)) {
      out[key] = isPlainObject(v) ? normaliseAgainst(tpl, v) : tpl;
      continue;
    }
    // A scalar (or a null template, which models a nullable) takes whatever
    // came back. See "what this does not do" above.
    out[key] = v;
  }

  return out as T;
}
