// The unfed-form-field allowlist, lifted out of check-unfed-form-fields.mjs so
// it can be READ without running it.
//
// The script's top level walks five source trees and ends in process.exit, which
// is correct for a CLI guard and fatal for an importer: a vitest case that
// imported it died with "process.exit unexpectedly called with 0" before a
// single assertion ran. Rather than restructure a working guard's control flow,
// the DATA moved. scripts/lib/ is where this repo already keeps values two
// callers share (see prd-priority.mjs).
//
// The list is the record of which multipart fields the edge parses that NO
// client sends. A field here has never arrived in production, so anything gated
// on it has never happened to anyone — which is exactly what
// src/test/badge-claims-match-capability.test.ts needs to know before deciding
// whether a page is allowed to advertise a badge.

/**
 * Fields the server parses that nothing sends, ON PURPOSE or pending work.
 *
 * Shrink-only, like the repo's other baselines: an entry that stops matching
 * FAILS, so a field that gets wired cannot keep its excuse. Every entry names
 * the story that owns it.
 */
export const ALLOWED = {
  // live_capture_opt_in and capture_sources were here and are now WIRED
  // (US-2802): the web camera dialog stamps each photo's origin and
  // new-submission.tsx sends both, from src/lib/photo-capture-contract.ts.
  // Their removal is this list doing its job.
  verified_360_opt_in:
    "US-2802. Still unfed, and not for want of a decision: verified-360.ts " +
    "scores photogrammetric/LiDAR coverage metrics, which a BROWSER cannot " +
    "measure. Web has nothing honest to send. It waits on the iOS/Android " +
    "half, where the sensors exist.",
  capture_360:
    "US-2802. The device-reported metrics that verified_360_opt_in gates. " +
    "Same blocker, and deliberately NOT declared in photo-capture-contract.ts " +
    "meanwhile — naming it under src/ would read as fed here and disarm this " +
    "very entry.",

  forensic_grade:
    "Exercised by the edge suite only. The forensic add-on is chosen at grade " +
    "time through the tier/add-on path rather than as its own form field, so " +
    "the parser is a compatibility shim rather than a missing client.",
  regrade_of:
    "Exercised by the edge suite only. A regrade is initiated server-side " +
    "from the prior submission, not posted by a client.",
};
