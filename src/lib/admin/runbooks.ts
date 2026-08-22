// US-910: in-app operational runbooks for on-call / operators.
//
// Curated, BUILD-TIME-BUNDLED operational playbooks distilled from the repo
// markdown (vault/10-ops/deploy.md, vault/10-ops/launch-checklist.md, COOLIFY.md, vault/10-ops/rollback.md,
// vault/10-ops/incident-response.md, vault/10-ops/backups.md) and the cron/jobs registry
// (services/edge-functions/src/lib/cron-runs.ts → CRON_REGISTRY). The point is
// that on-call has the playbook WHERE THE CONTROLS ARE, not buried in the repo:
// each runbook deep-links to the relevant admin control (`controls`).
//
// React-free so the search/lookup logic stays unit-testable and so a content
// check (src/lib/admin/__tests__/runbooks.test.ts) can statically prove no
// secrets/credentials are rendered here — only env-var NAMES, never values.

/** A deep link from a runbook to the admin control it describes. */
export interface RunbookControl {
  /** Button label. */
  label: string;
  /** In-app admin route (must stay inside /admin or /dashboard). */
  to: string;
  /** One-line "why you'd jump here". */
  description: string;
}

export interface Runbook {
  /** URL slug (also the stable id). */
  slug: string;
  title: string;
  /** Grouping label for the index. */
  category: string;
  /** One-line summary shown in the index + command palette subtitle. */
  summary: string;
  /** Extra search terms beyond the title/summary/body. */
  keywords: string[];
  /** Deep links to the live admin controls this runbook governs. */
  controls: RunbookControl[];
  /** Markdown body, rendered by MarkdownPreview. */
  body: string;
  /**
   * US-2076: the vault note this runbook was distilled from, if any.
   *
   * This copy is DELIBERATELY not the vault note — it is shorter, ordered for
   * reading under pressure, and deep-linked to the controls it governs. That is
   * the point of US-910. But a distilled copy drifts silently, and this is the
   * copy an operator reads during an incident, so each one declares its source
   * and when someone last checked the two still agree.
   *
   * `scripts/runbook-sync.mjs` fails when the source note has a commit newer
   * than `reviewed`. Same heuristic as the vault's own drift guard: it detects
   * that the source MOVED, not that this text is wrong. Bumping `reviewed`
   * asserts a human re-read both.
   *
   * Omit both for runbooks with no vault counterpart (cron-jobs, kill-switches).
   */
  sourceNote?: string;
  /** ISO date the distillation was last checked against `sourceNote`. */
  reviewed?: string;
}

export const RUNBOOKS: Runbook[] = [
  {
    slug: "deploy-order",
    sourceNote: "vault/10-ops/deploy.md",
    // Re-read 2026-08-19. NOTHING to carry: the only change in deploy.md since
    // the last check is the cron count moving 77 -> 78, and this copy names no
    // count on purpose (it says Scheduled Tasks survive a redeploy and points at
    // Background Jobs for the live list). A copy that quoted the number would
    // turn every new job into a stale runbook.
    //
    // Re-read 2026-08-17 against the vault note, and this time there WAS
    // something to edit — the first time in four checks.
    //
    // US-2665 and US-2609 both landed operator-facing facts in deploy.md, and
    // one of them is exactly what this copy exists for: an operator reading this
    // DURING an incident needs to know that `no available server` is what a
    // routine deploy produces, because it is also the documented signature of an
    // edge event-loop hang. Someone who has not been told that either escalates
    // a rollover or, worse, shrugs at a real hang. The compose-file line is the
    // second: it stops a chase for a setting the repo declares and the running
    // container does not have.
    //
    // The three prior checks cost a date bump and no edit because this copy
    // names no counts and points at CRON_REGISTRY instead — that phrasing
    // working, not the check being noisy.
    //
    // Re-read 2026-08-21. Nothing to carry, and the same reason a fourth time:
    // the whole diff is the cron count going 79 -> 80 for the style-code
    // discovery crawl. Worth stating plainly now that the pattern is this
    // consistent — the count is the ONLY line in deploy.md that moves often, and
    // every shipped copy deliberately refuses to quote it, so the drift guard
    // fires on the one fact none of them carry. That is the guard doing its job
    // (it cannot know which line changed) and the phrasing doing its job. If a
    // future copy is ever tempted to name the number, this is the four-check
    // record of why not.
    reviewed: "2026-08-21",
    title: "Production deploy order",
    category: "Deploy",
    summary:
      "Ship a change to prod in the load-bearing order: migrations → edge → frontend.",
    keywords: ["deploy", "release", "migration", "coolify", "cloudflare", "edge", "ship"],
    controls: [
      {
        label: "System Health",
        to: "/admin/ops/health",
        description: "Confirm readiness + schema version after each layer.",
      },
      {
        label: "Background Jobs",
        to: "/admin/ops/jobs",
        description: "Spot-check a scheduled task with Run-now post-deploy.",
      },
    ],
    body: [
      "GradeThread has **three independently-deployed layers**, and the deploy order is load-bearing, not stylistic:",
      "",
      "1. **Apply DB migrations first.** The edge asserts its schema version at boot and refuses to start in production against a DB behind its `EXPECTED_SCHEMA_VERSION` — deploy edge before migrations and the new container crash-loops by design. Migrations are forward-only and backward-compatible with the currently-running edge, so applying them early never breaks the old code.",
      "2. **Deploy the edge service second** (Deno/Hono on Coolify, `functions.gradethread.com`). New endpoints/fields must exist server-side before the frontend calls them — the edge is the contract.",
      "3. **Deploy the frontend last** (Cloudflare Pages, apex `gradethread.com`). The SPA may rely on new edge endpoints; shipping it first would 404 those calls for live users.",
      "",
      "## How each layer deploys",
      "",
      "- **Database** — manual apply (CLI / `psql`) against self-hosted Supabase. Back up prod FIRST. Apply pending files in order (each is idempotent), then record the applied versions into `supabase_migrations.schema_migrations` so the edge boot assertion stays active.",
      "- **Edge** — Coolify auto-deploys on push to `main` via its deploy webhook; a manual **Redeploy** builds from the latest commit. Coolify Scheduled Tasks live on the service, so they survive a redeploy.",
      "",
      "> **A deploy makes the API answer `no available server` for a few seconds, and that is the same string a real edge HANG produces.** Every push rolls the single edge container, including a docs-only commit — there is no path filter. During or just after a deploy, two 503s followed by a 200 is the rollover, not an incident. Re-check `/health/ready` a few seconds later before escalating; if it stays down past a minute, it is not the rollover.",
      "",
      "> **`docker-compose.coolify.yml` is not the deployed configuration.** Measured 2026-08-17: `/health/metrics` reports no memory limit while that file declares 2048 MB. If you are chasing a setting that \"should\" be set, check the Coolify UI rather than the repo file — and expect the two to disagree.",
      "",
      "- **Frontend** — Cloudflare Pages auto-deploys on push to `main`. Build command runs the TypeScript check → Vite build → prerender. Pages env-var changes only take effect on the next build.",
      "",
      "## Post-deploy verification",
      "",
      "A deploy is \"done\" only when the smoke checks are green:",
      "",
      "- `GET /health/ready` reports `status: \"ready\"` and edge logs show the schema-version OK line.",
      "- A Stripe webhook trigger, a certificate page render, and the SEO endpoints all succeed.",
      "- For a release that touches the money/grade path, also run the Playwright critical-path e2e.",
      "",
      "**Before calling a shipped frontend fix broken, rule out the service worker.** The PWA precaches the app into Cache Storage, and a hard reload clears the HTTP cache but not that — so a correct deploy can keep serving the old behaviour. Check in a private window first; if the fix works there, unregister the service worker and clear site data rather than re-deploying.",
      "",
      "If readiness is `not_ready` or a feature shows missing, fix the env/migration and redeploy that layer — don't leave a half-green deploy in rotation.",
    ].join("\n"),
  },
  {
    slug: "rollback",
    sourceNote: "vault/10-ops/rollback.md",
    // 2026-08-09: re-read against the note, which gained a warning that the
    // /health release field is unreliable (US-2001, measured). Added the same
    // caveat to the edge step below — the identify-the-build step is the one an
    // operator reaches for mid-incident, and it was quietly blind.
    reviewed: "2026-08-09",
    title: "Roll back a bad deploy",
    category: "Deploy",
    summary:
      "Reverse the deploy order to recover: frontend → edge; schema is forward-only.",
    keywords: ["rollback", "revert", "recover", "regression", "bad deploy", "pages"],
    controls: [
      {
        label: "System Health",
        to: "/admin/ops/health",
        description: "Confirm readiness recovers after the rollback.",
      },
      {
        label: "Feature Flags",
        to: "/admin/ops/feature-flags",
        description: "Kill a feature instantly instead of a full rollback when the blast radius is one feature.",
      },
    ],
    body: [
      "Roll **back** in the reverse of the deploy order: frontend first, then edge. Schema is forward-only — never drop a column to roll back; compensate with a new migration or restore from backup.",
      "",
      "## Decide the smallest reversible unit",
      "",
      "Before a full layer rollback, ask whether the blast radius is a single feature. If so, **disable the feature flag** (instant, fleet-wide within the cache TTL) instead — see the kill-switches runbook.",
      "",
      "## Frontend (Cloudflare Pages)",
      "",
      "- Pages → Deployments → **Rollback** to a previous deployment. Instant, no rebuild.",
      "",
      "## Edge service (Coolify)",
      "",
      "- Coolify → Deployments → redeploy the previous successful commit, or revert the commit on `main` and let the webhook redeploy.",
      "- The edge is backward-compatible with the prior frontend, so an edge rollback is safe to do on its own.",
      "- **Do not expect `/health` to tell you which build is running.** It returned `release: \"dev\"` when last measured (2026-08-09, US-2001), so identify the build from Coolify's deployment history instead. Check `curl -s https://functions.gradethread.com/health | jq .release` now rather than during an incident — if it still says `dev`, setting `SOURCE_COMMIT` as a Coolify environment variable fixes it without a rebuild.",
      "",
      "## Database",
      "",
      "- **Forward-only.** For a catastrophic migration, restore from backup (see the restore-drill runbook). Otherwise write a compensating migration — do not `DROP`.",
      "",
      "After any rollback, re-run the post-deploy smoke checks and watch System Health until readiness is green.",
    ].join("\n"),
  },
  {
    slug: "restore-drill",
    sourceNote: "vault/10-ops/backups.md",
    reviewed: "2026-08-17",
    title: "Backup & restore drill",
    category: "Resilience",
    summary:
      "Prove the database backup is restorable end-to-end before you need it for real.",
    keywords: ["backup", "restore", "drill", "disaster recovery", "dr", "pitr", "snapshot"],
    controls: [
      {
        label: "System Health",
        to: "/admin/ops/health",
        description: "Use table sizes + DB latency as the before/after sanity check for a restore.",
      },
    ],
    body: [
      "A backup you have never restored is a hope, not a backup. Run this drill on the cadence in the launch checklist so a real restore is muscle memory.",
      "",
      "> **Before trusting any recovery-point number: confirm the nightly cron is actually installed.** Everything below, and the RPO in the backups runbook, describes a mechanism that is verified to WORK. Whether anything RUNS it on a schedule in production has never been confirmed (US-2002). If it is not installed, the real exposure is not 24 hours of loss — it is total loss. On the DB host, `crontab -l` should list the backup line, and the offsite bucket should hold a dump from the last 24h WITH its `.sha256` beside it; a dump with no checksum is a backup nobody has proven readable.",
      "",
      "> **The object must end in `.age`, and a bare `.dump` is a FAILURE, not a pass (US-2416).** Since backups are encrypted before they leave the host, the offsite names are `gradethread-<ts>.dump.age` and `gradethread-<ts>.dump.age.sha256`. Seeing `gradethread-<ts>.dump` with a checksum beside it looks exactly like success and is not: it means an older script version is still deployed and the nightly is shipping **plaintext** — a full dump of every user, address, grade and credit-ledger row, protected by nothing but the R2 credential. Check the extension before you tick this box.",
      "",
      "> **You cannot run this drill today, and that is expected.** `backup-postgres.sh` REFUSES to upload when `BACKUP_AGE_RECIPIENT` is unset, and the keypair has not been created yet (US-2416 built the mechanism; production has not moved). Create the keypair first — see the backups runbook — or the drill stops at step 1.",
      "",
      "## Drill steps",
      "",
      "1. **Take a fresh backup** of prod Postgres using the documented backup procedure. Note the timestamp and size. The artifact is encrypted on the host, so what lands offsite is `.age`.",
      "2. **Restore into a throwaway target** (a scratch database / staging instance), never over prod. `restore-postgres.sh` verifies the checksum, then DECRYPTS, then restores — so you must point `BACKUP_AGE_IDENTITY` at the private key file first. **An age-encrypted dump without its identity is random bytes forever.** The identity needs at least two independent, durable homes, and neither of them may be the machine being backed up.",
      "3. **Verify integrity** — row counts on the high-value tables (users, submissions, grade_reports, listings, sales) are in the expected range, and a spot-checked certificate row resolves.",
      "4. **Time it.** Record how long the restore took end-to-end; that number is your real RTO.",
      "5. **Tear down** the throwaway target.",
      "",
      "## The photos are a second restore, with its own script (US-2659)",
      "",
      "Everything above is Postgres. The storage mirror — every listing photo, every grading photo including label shots, every certificate asset — is a separate job, and until 2026-08-16 it had a backup script and no restore path at all. It had never been read back.",
      "",
      "1. **Full rebuild** (the volume is gone): `RCLONE_REMOTE=r2crypt:gradethread-backups bash scripts/ops/restore-storage.sh /var/lib/supabase/storage` into an EMPTY target.",
      "2. **One deleted photo** is a different operation: restore the dated `storage-deleted/<ts>` prefix into a SCRATCH directory and copy the single file across. Never point the full-rebuild form at the live volume to recover one object — it pulls the whole prefix and drags every other file back to its backed-up state.",
      "",
      "> **`rclone` exiting 0 is not success.** It returns 0 for a copy that produced zero files, and a crypt remote with the wrong password does not error on *listing* — it yields names that decrypt to garbage. `restore-storage.sh` therefore refuses an empty restore and re-checks a sample byte-for-byte; that content check is the only thing that actually proves the password.",
      "",
      "> **The decryption password lives on the host this backup exists to survive losing.** If that box is gone, every object in R2 is unreadable ciphertext and no script here can help. This is the open half of US-2659 and it is an operator action, not a code change.",
      "",
      "Rehearse it with `bash scripts/ops/restore-storage-drill.sh` — it needs only `rclone`, no Docker, no network and no cloud credential, because it builds an ephemeral crypt remote over a local directory. It also proves the single-object path, not just the bulk one.",
      "",
      "## What to watch",
      "",
      "- Compare table sizes and DB latency on **System Health** before and after a real restore — a large unexplained delta is a red flag.",
      "- If the restore fails or the numbers look wrong, treat it as an incident and follow the incident-response runbook.",
      "",
      "Schema is forward-only, so a restore is the only true rollback for a catastrophic migration — keep this drill green.",
    ].join("\n"),
  },
  {
    slug: "cron-jobs",
    title: "Scheduled jobs reference",
    category: "Operations",
    summary:
      "What each recurring job does, when it runs, and where to watch it. Live schedule + last-run is on Background Jobs.",
    keywords: ["cron", "jobs", "scheduled", "coolify tasks", "queue", "ledger", "reprice", "newsletter", "drip"],
    controls: [
      {
        label: "Background Jobs",
        to: "/admin/ops/jobs",
        description: "Live schedule, last-run outcome, next-due, and Run-now for every cron.",
      },
      {
        label: "Dead Letters",
        to: "/admin/ops/dead-letters",
        description: "Replay or discard webhook/email work a job couldn't process.",
      },
    ],
    body: [
      "Recurring work runs as **Coolify Scheduled Tasks** that POST to job endpoints on the edge. Every `/api/jobs/*` hit appends a row to the `cron_runs` ledger, so the Background Jobs page shows each job's last run, outcome, duration, and next-due. The table below is the curated map; the **live** registry (and Run-now) lives on Background Jobs.",
      "",
      "**A run can be marked failed while its HTTP status is 200.** Sweeps that process many items — payouts, guarantee-pool reconciliation — report their own failure counts in the response body, so a run that transferred nothing still answered 200. The ledger reads that body: any non-zero `failed` / `errors` / `discrepancies` count records the run as an error and raises a `job.failed` warning. The HTTP status stays 2xx on purpose, because Coolify invokes these with `curl -fsS` and a 5xx would mark the scheduled task itself failed and re-run the whole sweep. Cron fleet health reports these separately as **failing** (ticking, but erroring) from **stalled** (not ticking at all).",
      "",
      "## Maintenance & integrity",
      "",
      "- **Email outbox retry** (`*/5 * * * *`) — backoff + dead-letter for failed sends.",
      "- **DB integrity scan** (`0 7 * * *`) and **Data-retention purge** (`0 4 * * *`).",
      "- **Push-token prune** (`0 3 * * *`).",
      "",
      "## Grading & sync",
      "",
      "- **Stuck-submission recovery** (`*/10 * * * *`) and **Grading regression monitor** (`0 */12 * * *`).",
      "- **eBay sync reaper** (`*/15 * * * *`), **eBay token refresh** (hourly), **eBay order-sync backstop** (`*/30 * * * *`).",
      "",
      "## Listings, repricing & publish",
      "",
      "- **Repricing scan / rules** (`0 */6 * * *`), **Listing automation rules** (hourly).",
      "- **AutoLister reclaim** and **Publish-batch reclaim** (`*/5 * * * *`).",
      "",
      "## Growth & lifecycle email",
      "",
      "- **Newsletter kickoff trigger** + **weekly dispatch** (hourly, self-gating on cadence), **A/B finalize** (`*/15 * * * *`), **self-tuning** and **topic-bank refill**.",
      "- **Trial-drip orchestration tick** (hourly), **Lifecycle email-journey tick** (daily), **Scheduled-campaign dispatch** (`*/15 * * * *`), **Trial-expiry downgrade** (daily).",
      "",
      "## Safety, SEO & billing",
      "",
      "- **Abuse-signal scan** (`0 */6 * * *`), **Search Console sync** (daily), **Condition Index refresh** (daily), **North Star weekly digest** (Mondays).",
      "",
      "> Schedules are interpreted in **UTC** (Coolify cron runs UTC). Crons served outside `/api/jobs/*` are in the ledger too — the recorder is mounted by path, so eBay token refresh and the content ticks record like any other. The only jobs with no ledger row are the two one-off backfills, which have no cadence to miss. If a job is failing repeatedly, check its detail on Background Jobs and the Dead Letters queue for unprocessed work.",
    ].join("\n"),
  },
  {
    slug: "kill-switches",
    title: "Kill-switches & feature flags",
    category: "Operations",
    summary:
      "Disable a feature fleet-wide in seconds when it misbehaves — no deploy required.",
    keywords: ["kill switch", "feature flag", "flag", "disable", "toggle", "rollout", "canary"],
    controls: [
      {
        label: "Feature Flags",
        to: "/admin/ops/feature-flags",
        description: "Toggle a flag, set rollout %, or allow/deny specific accounts.",
      },
      {
        label: "Maintenance",
        to: "/admin/ops/maintenance",
        description: "Put the whole app into a maintenance window when a flag isn't enough.",
      },
    ],
    body: [
      "When a feature misbehaves in prod, the fastest safe lever is its **feature flag** — not a rollback. A flag change propagates fleet-wide within the flag cache TTL (~30s), with no deploy.",
      "",
      "## How flags resolve",
      "",
      "Each flag has a global enable, a rollout percentage, plan targets, per-account allow/deny lists, and an optional schedule window. Precedence is: **global kill → schedule → deny → allow → plan → percentage**. Flags fail **open** by default (a missing row is treated as enabled), so an explicit `enabled: false` is what actually kills a feature.",
      "",
      "## Kill a feature now",
      "",
      "1. Open **Feature Flags** and find the key (e.g. grading, autolister, repricing, content_ai, newsletter, trial_conversion_drip, lifecycle_journeys, support_assistant).",
      "2. Set the global toggle to **off** (super-admin + MFA step-up; the change is written to the admin audit log).",
      "3. Confirm the blast radius shrank on **System Health** / the relevant dashboard within ~30s.",
      "",
      "## When a flag isn't enough",
      "",
      "If the problem spans the whole app (DB, auth, edge boot), use a **Maintenance** window instead, and follow the incident-response runbook.",
      "",
      "To re-enable, flip the flag back on — or ramp it with the rollout percentage / allow-list to canary the fix before full exposure.",
    ].join("\n"),
  },
  {
    slug: "incident-response",
    sourceNote: "vault/10-ops/incident-response.md",
    reviewed: "2026-08-01",
    title: "Incident response",
    category: "Resilience",
    summary:
      "First moves when prod is on fire: assess, contain, communicate, recover, review.",
    keywords: ["incident", "outage", "on-call", "p1", "sev", "alert", "escalation", "postmortem"],
    controls: [
      {
        label: "Activity Feed",
        to: "/admin/ops/activity",
        description: "Live critical-event feed — start here to see what fired and acknowledge it.",
      },
      {
        label: "System Health",
        to: "/admin/ops/health",
        description: "Readiness, DB latency, storage, and the slowest recent jobs at a glance.",
      },
      {
        label: "Dead Letters",
        to: "/admin/ops/dead-letters",
        description: "Find and replay work that failed during the incident.",
      },
    ],
    body: [
      "Work the incident in order. Don't skip to a fix before you've contained the blast radius.",
      "",
      "## 1. Assess",
      "",
      "- Open the **Activity Feed** and acknowledge the firing event(s). Check **System Health** for readiness, DB latency, and storage.",
      "- Establish scope: one feature, one tenant, or the whole platform?",
      "- **Check health, not status, and test the public hostname.** An edge container can sit `Up (unhealthy)` while the dashboard still reads \"running\": the process is alive, so nothing restarts it, and the load balancer has already dropped it. That shows up as a steady 503 from the API host while the marketing site stays fine — so \"only the product is broken\" is a symptom, not a coincidence. A restart recovers it in seconds. This is the opposite of a crash-loop, which restarts itself and leaves a boot error in the logs; a hang logs nothing at all.",
      "",
      "## 2. Contain",
      "",
      "- One feature → disable its **feature flag** (kill-switches runbook).",
      "- Whole app / data layer → open a **Maintenance** window.",
      "- A bad release → roll back the offending layer (rollback runbook).",
      "",
      "## 3. Communicate",
      "",
      "- Post status to the team channel and the public status surface if customers are affected. Keep a running timeline of what you changed and when.",
      "",
      "## 4. Recover",
      "",
      "- Apply the fix or rollback. Replay stuck work from **Dead Letters**. For a catastrophic DB issue, restore from backup (restore-drill runbook).",
      "- Re-run the post-deploy smoke checks; watch readiness return to green.",
      "",
      "## 5. Review",
      "",
      "- Write a blameless postmortem: timeline, root cause, what detected it, and the follow-up actions to prevent recurrence.",
    ].join("\n"),
  },
  {
    slug: "launch-readiness",
    sourceNote: "vault/10-ops/launch-checklist.md",
    // Re-read 2026-08-15. Two changes in the vault note, neither of which this
    // copy carries. (1) One more generated table row (grading-self-consistency)
    // and the count line 77 → 78 — §2 here says "all Coolify Scheduled Tasks
    // exist ... re-add every task" and names no number, on purpose, so the
    // generated table stays the source. (2) A section recording that Android is
    // NOT a launch gate. That is a scope decision about the backlog, not a step
    // in the gate, and this copy is the steps.
    //
    // Third consecutive cron addition costing a date bump and no edit. If this
    // copy ever quotes the count, every new job turns it into a stale runbook.
    //
    // Re-read 2026-08-19, and this time there WAS something to carry. The vault
    // note's migrations row now says to check status "match" AND that no
    // "missing" key is present, because on 2026-08-15 prod really did answer
    // applied 00606, status match, missing ["00594"] — a schema reporting itself
    // fine while naming a migration absent from it. §4 here said only that
    // /health/ready is ready, so an operator working from this copy alone would
    // have cleared the gate on that database. Now it says what to look at.
    // (The cron count moved again, 78 -> 77 -> 78; still not quoted here, and
    // still on purpose.)
    //
    // Re-read 2026-08-21. One change, and nothing to carry: a paragraph under
    // the Android row saying the Play listing now exists in the repo
    // (android/PLAY_STORE_SUBMISSION.md), that Android is still not a launch
    // gate, and that preparing it surfaced one policy blocker which was fixed
    // rather than deferred (in-app account deletion, US-2776). That is the same
    // scope decision the 2026-08-15 re-read declined to carry, for the same
    // reason: this copy is the steps an operator runs, not the shape of the
    // backlog. US-2776 itself adds a public legal page, which §4's "the SEO
    // endpoints succeed" already covers and the prerender guards already test.
    reviewed: "2026-08-21",
    title: "Launch readiness gate",
    category: "Deploy",
    summary:
      "The is-everything-configured gate: env vars, scheduled tasks, backups, and smoke.",
    keywords: ["launch", "checklist", "readiness", "env", "config", "go-live", "pre-flight"],
    controls: [
      {
        label: "System Health",
        to: "/admin/ops/health",
        description: "Readiness endpoint surfaces any missing feature/config as not_ready.",
      },
      {
        label: "Settings Registry",
        to: "/admin/ops/settings",
        description: "Review the tunable system settings the platform reads at runtime.",
      },
      {
        label: "Feature Flags",
        to: "/admin/ops/feature-flags",
        description: "Confirm the launch set of features is enabled at the intended rollout.",
      },
    ],
    body: [
      "This is the **is-everything-configured** gate to clear before (and after) go-live. It complements the deploy-order runbook, which covers the mechanics of shipping.",
      "",
      "## 1. Environment",
      "",
      "- Edge service has every required variable set in Coolify (Supabase URL + service-role key, Anthropic key, Stripe secret + webhook secret, `PORT`). **Names only** — never paste a value into a runbook, ticket, or chat.",
      "- Frontend has its `VITE_*` set in Cloudflare Pages → Production. Pages env changes only take effect on the **next** build.",
      "",
      "## 2. Scheduled tasks",
      "",
      "- All Coolify Scheduled Tasks exist and point at the right job endpoints. After recreating the service, re-add every task. Spot-check one with **Run-now** from Background Jobs.",
      "",
      "## 3. Backups & resilience",
      "",
      "- Automated backups are running and a restore drill has passed recently (restore-drill runbook).",
      "",
      "## 4. Smoke",
      "",
      "- `GET /health/ready` is `ready`, its `schema` reads `status` `match`, and there is **no `missing` key** — a hole under the recorded maximum reports `incomplete`, and prod has answered `match` while naming a migration missing from it. A Stripe webhook trigger, a certificate render, and the SEO endpoints succeed.",
      "- Feature flags for the launch set are enabled at the intended rollout.",
      "",
      "If readiness reports `not_ready` or any feature shows missing, fix the env/migration and redeploy that layer — do not launch on a half-green gate.",
    ].join("\n"),
  },
];

/** Distinct categories in registry order (first-seen). */
export const RUNBOOK_CATEGORIES: string[] = Array.from(
  new Set(RUNBOOKS.map((r) => r.category)),
);

/** Look a runbook up by slug. */
export function getRunbook(slug: string): Runbook | undefined {
  return RUNBOOKS.find((r) => r.slug === slug);
}

/**
 * Case-insensitive search across title, summary, category, keywords and body.
 * Returns all runbooks for a blank query; ranks title/summary/keyword hits
 * ahead of body-only hits so the most relevant runbook leads.
 */
export function searchRunbooks(query: string): Runbook[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...RUNBOOKS];
  const scored: Array<{ rb: Runbook; score: number }> = [];
  for (const rb of RUNBOOKS) {
    const strong =
      `${rb.title} ${rb.summary} ${rb.category} ${rb.keywords.join(" ")}`.toLowerCase();
    let score = 0;
    if (strong.includes(q)) score = 2;
    else if (rb.body.toLowerCase().includes(q)) score = 1;
    if (score > 0) scored.push({ rb, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.rb);
}
