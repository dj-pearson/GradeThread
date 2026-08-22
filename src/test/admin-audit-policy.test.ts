// US-2355 AC1: every admin mutation is CLASSIFIED, and the classification is
// checked in.
//
// The AC asks that every admin mutation write an audit row, guarded against
// drift. `admin-audit-coverage_test.ts` holds the specific forensic holes that
// were found and fixed. What stayed open was the other half, and its own header
// says why: "a judgement pass over 100+ routes". An unbounded review does not
// get done. So this reframes it as a list that starts complete and stays that
// way.
//
// The rule enforced here is NOT "every admin mutation must audit". That rule is
// wrong, and shipping it would be worse than nothing — a large share of admin
// POSTs are read-only computations that merely take a request body, and forcing
// audit rows for /preview and /analyze dilutes the log that matters until
// nobody reads it. The rule is: every admin mutation with no central trail is
// ACCOUNTED FOR, either as a deliberate exemption with a reason, or as an open
// question with a name on it.
//
// So a new unaudited admin mutation cannot appear quietly. It fails here until
// someone writes down which of the two it is.
//
// ── on trusting the numbers below ────────────────────────────────────────────
// The classifier resolves indirection, and it has to. Three shapes hid audit
// calls from a naive scan, and every one of them made an audited route look
// unaudited:
//   • a local wrapper over writeAuditLog (admin-grading, admin-claims);
//   • a shared handler FACTORY registered by call (admin-claims approve/reject);
//   • a lib function the handler delegates to (admin-ads recordDecision).
// Unresolved, the report said 97 of 210 routes were unaudited. Resolved, 19 —
// and the 78 differences included the guarantee-claim payout routes. A report
// that cries wolf on the money paths is a report that gets dismissed whole,
// taking the real findings with it.
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script, no type declarations by design.
import { auditRows } from "../../scripts/audit-admin-mutations.mjs";

interface Row {
  file: string;
  method: string;
  path: string;
  central: boolean;
  domain: string | null;
  writes: boolean;
  stepUp: boolean;
}

const key = (r: { file: string; method: string; path: string }) =>
  `${r.file} ${r.method} ${r.path}`;

/**
 * Deliberately NOT audited to admin_audit_log, and why.
 *
 * The test of a good entry here is whether an investigator reconstructing "what
 * did this admin do, and what changed because of it" would miss anything. If
 * the answer is no, the row would be noise, and noise is not free — it is what
 * makes the real rows hard to find.
 */
const EXEMPT: Record<string, string> = {
  // ── the admin's own workspace. Nobody else is affected, and there is no
  // before-state anyone would want back.
  "admin-views.ts POST /":
    "creates a saved view for the admin themselves — a personal filter, not a " +
    "change to anything another person can see",
  "admin-views.ts DELETE /:id":
    "deletes the admin's OWN saved view; the guard's tenant scoping already " +
    "stops it reaching anyone else's",
  "admin-notifications.ts PATCH /":
    "marks the admin's own notifications read — the definition of a change " +
    "with no forensic consequence",

  // ── read-only computation that happens to persist its result. The result is
  // an artifact to look at; acting on it is a different, audited route.
  "admin-newsletter.ts POST /issues/:id/preview":
    "renders a preview and writes nothing durable; sending is a separate route " +
    "and that one audits",
  // ── Surfaced 2026-08-10 by the classifier fix. All four are POSTs that WRITE
  // NOTHING — they take a request body and compute an answer — which is the
  // same category as the four entries around them, and the existing rule is
  // that a log full of "someone previewed a thing" is a log nobody reads.
  // Verified individually rather than assumed from the read-only column: the
  // column is only trustworthy now that the slicer stopped appending unrelated
  // code, so this is the first run where it could be believed.
  "admin-ads.ts POST /generate":
    "generates ad copy suggestions and returns them; nothing is persisted until " +
    "a separate route acts on one, and that route audits",
  "admin-bulk.ts POST /resolve":
    "takes a list of ids/emails and answers which exist — a lookup with a body " +
    "because the list is too long for a query string. It reads users and writes " +
    "nothing; the bulk ACTIONS are separate routes",
  "admin-drip.ts POST /campaigns/:campaign/simulate":
    "simulates a drip campaign against a cohort and returns what WOULD send. " +
    "Sending is a different route and it audits",
  "admin-flags.ts POST /preview":
    "evaluates a feature-flag rollout against a sample and returns the buckets. " +
    "Changing a flag is PUT /:key, which audits",

  // ── Surfaced 2026-08-14 when strip() stopped eating most of a file. A `/*`
  // written inside a `//` comment opened a block comment that ran to the next
  // terminator anywhere below it, so 17 of admin-billing.ts's 21 routes — and
  // these four — were never scanned at all. Same category as the block above:
  // each takes a body, computes an answer and persists nothing.
  "admin-drip.ts POST /campaigns/:campaign/validate":
    "validates a proposed campaign graph and returns the problems. Saving the " +
    "graph is the PUT, and that one writes",
  "admin-drip.ts POST /campaigns/:campaign/preview":
    "renders one step's HTML for a sample user, from the UNSAVED body the client " +
    "sends. Nothing is stored and nothing is sent",
  "admin-drip.ts POST /campaigns/:campaign/regenerate":
    "asks Claude for draft subject + HTML from a brief and returns it for review. " +
    "The route's own header says it does not persist; saving is the PUT",
  "admin-growth.ts POST /segments/preview":
    "counts who a proposed segment would match. A query with a body because the " +
    "filter is too big for a query string",

  "admin-ads.ts POST /analyze":
    "runs the REPORT-ONLY Claude analysis and stores recommendations. It never " +
    "touches Google Ads — applying a recommendation does, and " +
    "/recommendations/:id/apply is a MUST_AUDIT entry",
  "admin-grading.ts POST /model-comparison":
    "scores models against the golden set and stores the comparison. It cannot " +
    "change a live grade or activate a prompt version; activation is audited",

  // ── importing data from elsewhere. The admin chose WHEN, not WHAT, and the
  // source system holds the record of what arrived.
  "admin-ads.ts POST /apple/sync":
    "pulls Apple Search Ads figures into the shared reporting tables. A manual " +
    "refresh of imported numbers, not a decision about them",
  "admin-ads.ts POST /google/sync":
    "the Google half of the same import — pulls spend and performance figures " +
    "in, and changes nothing in the ad account",
  "admin-ads.ts POST /keywords/ingest":
    "pulls keyword research into the internal library — an ingestion the admin " +
    "triggers, carrying no choice worth reconstructing",

  // ── internal working material. Real writes, but to the team's own scratch
  // surfaces, where the row itself carries who and when.
  "admin-ads.ts POST /themes":
    "creates a keyword theme in the internal library. Themes shape drafts; " +
    "spend changes only through the apply/revert routes, which audit",
  "admin-ads.ts POST /creatives":
    "saves a generated creative as a draft. Publishing is elsewhere",
  "admin-tasks.ts POST /projects":
    "creates a project on the internal task board — no customer-visible state, " +
    "and DELETE on the same board IS audited because that one destroys history",
  "admin-tasks.ts PATCH /projects/:id":
    "edits a task-board project; the row carries updated_at and the board shows " +
    "its own history",
  "admin-tasks.ts POST /tasks/:id/comments":
    "adds a comment to an internal task, attributed to its author on the row",
};

/**
 * Not yet ruled on. Listed so they are visible rather than quietly blessed.
 *
 * These are the ones where the honest answer is "somebody has to decide", and
 * writing a confident reason for them would be the failure this whole exercise
 * is guarding against.
 */
const OPEN: Record<string, string> = {
  "admin-ads.ts POST /recommendations/:id/approve":
    "writes to ads_change_audit, not admin_audit_log. Approving moves real ad " +
    "spend, so the action IS recorded — but only where the ads screen looks. " +
    "An investigator asking 'what did this admin do' reads the central log and " +
    "sees nothing. DECISION NEEDED: mirror these into admin_audit_log, or " +
    "declare per-feature trails a first-class part of the audit story",
  "admin-ads.ts POST /recommendations/:id/dismiss":
    "same trail, same question — and dismissing is the one that leaves no other " +
    "evidence, because nothing downstream changes",
  "admin-ads.ts POST /recommendations/:id/snooze":
    "same trail, same question. Snoozing is the quietest of the three: the " +
    "recommendation simply stops appearing, so nobody is prompted to ask who " +
    "decided that or when it comes back",
  "admin-grading.ts POST /reliability/studies/:id/ratings":
    "records a rater's score in an inter-rater reliability study. The rating " +
    "row names its rater, so it is attributable; whether an ADMIN submitting " +
    "study ratings belongs in the central log is a call about how much the " +
    "study is treated as evidence",

  // ── Surfaced 2026-08-10 when the classifier stopped over-attributing.
  //
  // These were all reported as AUDITED and none of them are. The old
  // declaration slicer ran each top-level declaration to the next one, so a
  // route referencing any constant in the file inherited a slice containing
  // some OTHER route's audit call. 48 declarations across the admin files had
  // that property. These six are the routes it actually masked.
  //
  // Filed OPEN rather than EXEMPT deliberately: each one writes, and "an agent
  // never decided this was fine, a parsing accident decided it" is not the same
  // as a decision. They need a real ruling, not my guess at one.
  // RESOLVED 2026-08-22 (US-2803) and left here as a worked example of what an
  // OPEN entry is for. It asked for "a real ruling, not my guess at one", and
  // the ruling arrived from an unrelated direction: adding a RESTORE route to
  // this pair meant either auditing both or filing a second silent write beside
  // the first. Both now call writeAuditLog — archive_ad_theme and
  // restore_ad_theme — so the entry is gone rather than re-argued. The file
  // already imported writeAuditLog for its other routes, which is what made
  // this an omission rather than a policy.
  "admin-grading.ts POST /review/:id/release":
    "releases a claimed human review back to the queue. Claim (line 3089) and " +
    "approve (3172) both audit; release, between them, does not — which reads " +
    "like an omission rather than a decision. It touches a customer's grade " +
    "workflow, and 'who let this one go, and when' is exactly the question a " +
    "review-queue dispute asks",
  "admin-newsletter.ts POST /deliverability/enforce":
    "writes an ops_events row and flips a settings value, so it is recorded — " +
    "in the same per-feature-trail shape the ads routes above are OPEN for. " +
    "Same question, same answer needed: is a domain trail part of the audit " +
    "story or not",
  "admin-tasks.ts POST /tasks":
    "creates an internal task with no audit row. The DELETE routes in this file " +
    "audit (lines 137, 216, 282) and the creates and updates do not, which looks " +
    "like a deliberate 'destruction is what needs a trail' rule — but nothing " +
    "says so, and the classifier's accident is why nobody had to state it",
  "admin-tasks.ts PATCH /tasks/:id":
    "same file, same asymmetry: updates are unaudited while deletes are audited. " +
    "If the rule is 'only destruction needs a trail', say it once here and these " +
    "become EXEMPT",
  "admin-tasks.ts POST /import":
    "bulk-inserts tasks. The same rule question as the two above, with more rows " +
    "per action and therefore a bigger gap if the answer is that creates should " +
    "be audited",
};

describe("US-2355 AC1: admin mutations are all accounted for", () => {
  const rows = auditRows() as Row[];

  it("finds the admin surface at all", () => {
    // A refactor that renames the route files or the registration style would
    // otherwise empty this report and pass everything below vacuously — the
    // failure mode where a guard reports success because it stopped looking.
    expect(rows.length).toBeGreaterThan(150);
    expect(rows.filter((r) => r.central).length).toBeGreaterThan(100);
    expect(new Set(rows.map((r) => r.file)).size).toBeGreaterThan(10);
  });

  it("every mutation without a central audit row is classified", () => {
    const unclassified = rows
      .filter((r) => !r.central)
      .filter((r) => !(key(r) in EXEMPT) && !(key(r) in OPEN))
      .map(
        (r) =>
          `${key(r)}${r.writes ? " (WRITES)" : " (read-only)"}` +
          (r.domain ? ` → ${r.domain}` : ""),
      );

    expect(
      unclassified,
      "A new admin mutation writes no row to admin_audit_log. That is allowed, " +
        "but it has to be a decision rather than an oversight: add it to EXEMPT " +
        "with the reason an investigator would not miss it, add it to OPEN if " +
        "the answer is genuinely unclear, or call writeAuditLog.",
    ).toEqual([]);
  });

  it("the lists do not rot", () => {
    // An entry naming a route that no longer exists is worse than a missing
    // one: it reads as a considered decision about live code. This is the half
    // that goes stale silently, because nothing else ever reads these keys.
    const live = new Set(rows.map(key));
    const stale = [...Object.keys(EXEMPT), ...Object.keys(OPEN)].filter(
      (k) => !live.has(k),
    );
    expect(
      stale,
      "these classified routes no longer exist — renamed, removed, or the " +
        "audit was added and the exemption should go with it",
    ).toEqual([]);
  });

  it("no route is both exempt and open", () => {
    const both = Object.keys(EXEMPT).filter((k) => k in OPEN);
    expect(both).toEqual([]);
  });

  it("every classification carries an actual reason", () => {
    // The point of the list is the reasons. A one-word entry is a box ticked,
    // and the next reader cannot tell whether it was thought about.
    const thin = Object.entries({ ...EXEMPT, ...OPEN })
      .filter(([, why]) => why.trim().length < 40)
      .map(([k]) => k);
    expect(thin).toEqual([]);
  });

  it("acknowledging a critical alert is audited whether or not it is bulk", () => {
    // The finding that made this report worth writing. acknowledge-all was
    // fixed and the single-event route was not, which left the rule reading
    // "burying alerts is auditable unless you do it one at a time" — and the
    // loophole is the likelier path, because it does not look like a mass
    // action.
    for (const path of ["/events/:id/acknowledge", "/events/acknowledge-all"]) {
      const row = rows.find((r) => r.file === "admin-ops.ts" && r.path === path);
      expect(row, `${path} is gone or was renamed`).toBeTruthy();
      expect(row!.central, `${path} no longer writes to the central log`).toBe(
        true,
      );
    }
  });
});
