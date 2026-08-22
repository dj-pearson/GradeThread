#!/usr/bin/env node
// Local CI mirror — run the same gates GitHub Actions runs, BEFORE you push, so
// broken code never leaves the machine. Cross-platform (spawn with shell:true).
//
// Usage:
//   node scripts/verify.mjs              # default: web + edge + db
//   node scripts/verify.mjs --web        # frontend lane only (ci.yml build job)
//   node scripts/verify.mjs --edge       # edge/Deno lane only (security.yml deno-check)
//   node scripts/verify.mjs --db         # migrations lane only (db-migrations.yml) — needs Docker
//   node scripts/verify.mjs --security   # npm audit + Trivy image scan — needs Docker
//   node scripts/verify.mjs --ios        # iOS source guards only (no Xcode needed)
//   node scripts/verify.mjs --android    # Android lane (android-ci.yml) — needs JDK 17 + the SDK
//   node scripts/verify.mjs --e2e        # add the Playwright e2e suite (ci.yml e2e job)
//   node scripts/verify.mjs --all        # everything above
//
// Lane flags combine. With no lane flag, the default set is web + edge + db.
// Secrets are NOT scanned here — the pre-commit hook runs gitleaks on staged
// changes (the right moment for secret detection). See .githooks/pre-commit.
//
// The DB + security lanes need Docker running. If the daemon is down they are
// SKIPPED with a loud warning rather than failing the whole run — so a quick
// `npm run verify` still works without Docker. Turn Docker on (and re-run, or
// use `npm run verify:db`) whenever you touch supabase/migrations or the edge
// Dockerfile.
//
// NOTE (self-hosted Supabase): `supabase db start` / `db reset` boot a LOCAL,
// throwaway Supabase stack in Docker on localhost. It is migration-validation
// ONLY and is completely separate from the self-hosted production instance at
// api.gradethread.com — it never connects to or mutates prod. Don't `supabase
// link` / `db push` from here expecting to hit prod; prod is deployed by its
// own self-hosted process.

import { spawnSync } from "node:child_process";
import { inertLocalGates } from "./lib/inert-gates.mjs";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { resolvePython } from "./lib/python.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const edgeDir = resolve(root, "services/edge-functions");

const flags = new Set(process.argv.slice(2));

// ── US-2460: one run at a time ──────────────────────────────────────────────
//
// The lanes are NOT isolated. The build lane writes dist/ and its prerender step
// then reads and rewrites dist/_headers and dist/_redirects; the coverage lane
// writes a shared coverage directory. A second run entering those steps
// mid-flight sees a half-written tree.
//
// Observed 2026-08-10 with three runs in flight: the build and coverage lanes
// both reported FAILED, and both pass alone on the same commit. That is the
// expensive kind of wrong — a verification tool's output is the thing people act
// on without re-checking, so a failure that is not real costs a debugging
// session and a pass that was not earned costs more than that.
//
// Refuses rather than queues: a developer who ran it twice by accident wants to
// know, not to wait twice as long.
const lockPath = resolve(root, "node_modules/.cache/verify.lock");

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to someone else — still running.
    return err?.code === "EPERM";
  }
}

function takeLock() {
  if (flags.has("--force")) return () => {};
  mkdirSync(dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    let held;
    try {
      held = JSON.parse(readFileSync(lockPath, "utf8"));
    } catch {
      held = null; // unreadable → treat as stale
    }
    if (held?.pid && alive(held.pid)) {
      const mins = Math.round((Date.now() - (held.startedAt ?? Date.now())) / 60000);
      process.stderr.write(
        `\x1b[31mverify is already running\x1b[0m (pid ${held.pid}, ~${mins} min).\n` +
          "The lanes share dist/ and the coverage directory, so a second run " +
          "reports failures that are not real.\n" +
          "Wait for it, or re-run with --force if you know that run is dead.\n" +
          // US-2788: the takeover above only recognises a DEAD pid. A WEDGED
          // one is alive, holds the lock indefinitely and looks identical to a
          // slow run — which is how a hung `docker info` held this lock for
          // three hours and blocked every push on the machine. "Is it dead" is
          // the wrong question and the operator cannot answer it; "is it doing
          // anything" they can, and CPU time is the answer.
          (mins > 30
            ? "\n\x1b[33mOver 30 minutes is long for a verify run.\x1b[0m A run that is " +
              "WEDGED looks exactly like one that is slow. Check whether it is " +
              "doing any work rather than guessing:\n" +
              `  Windows: Get-Process -Id ${held.pid} | Select CPU   (run twice; ` +
              "unchanged = stuck)\n" +
              `  macOS/Linux: ps -o time= -p ${held.pid}             (same test)\n` +
              "If the CPU time does not move, it is not working. --force is safe then.\n"
            : ""),
      );
      // Non-zero: a wrapper script must never read this refusal as a pass.
      process.exit(2);
    }
    if (held?.pid) {
      process.stdout.write(
        `\x1b[33mtaking over a stale verify lock\x1b[0m (pid ${held.pid} is gone).\n`,
      );
    }
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const held = JSON.parse(readFileSync(lockPath, "utf8"));
      if (held.pid === process.pid) rmSync(lockPath, { force: true });
    } catch {
      // Someone else's lock, or already gone. Leave it.
    }
  };
  process.on("exit", release);
  // Ctrl-C during a four-minute build is the common case.
  //
  // ⚠ ON WINDOWS THIS HANDLER OFTEN DOES NOT RUN. Node emulates SIGINT for a
  // console Ctrl-C, but a programmatic `child.kill("SIGINT")` terminates the
  // process outright, so neither this nor the 'exit' handler fires — measured,
  // not assumed. The lock is then left behind, and THAT is what the stale-pid
  // takeover above is for: the next run finds a dead pid, says so, and
  // proceeds. Recovery is the property that matters here; releasing cleanly is
  // the nicety. Removing either one leaves the tool wedged after one Ctrl-C.
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      release();
      process.exit(130);
    });
  }
  return release;
}

const releaseLock = takeLock();

const anyLaneFlag = ["--web", "--edge", "--db", "--security", "--e2e", "--vault", "--ios", "--android", "--all"]
  .some((f) => flags.has(f));
const on = (name) => flags.has(`--${name}`) || flags.has("--all") || !anyLaneFlag && ["web", "edge", "db", "vault", "ios"].includes(name);

/**
 * Is a WORKING Docker daemon reachable?
 *
 * ⚠ THE TIMEOUT IS THE WHOLE POINT (2026-08-22). This was
 * `spawnSync("docker", ["info"])` with no timeout, and an UNRESPONSIVE daemon —
 * as opposed to an absent one — never answers. A verify run on this box sat on
 * that call for THREE HOURS: 0.1 CPU seconds total, one child stuck in
 * `cmd /c "docker info"`, and the whole run holding `verify.lock` the entire
 * time. Because the lock is what the pre-push hook waits on, a hung Docker
 * daemon silently blocked every push on the machine.
 *
 * "Docker is down" was always handled — the db and security lanes skip with a
 * warning. What was not handled is Docker being UP and not answering, which
 * looks identical to a slow start and is indistinguishable from progress
 * because `stdio: "ignore"` prints nothing while it waits.
 *
 * 20s is generous for a daemon that is going to answer at all: a cold Docker
 * Desktop replies in a few seconds. Past that it is not slow, it is stuck, and
 * treating it as absent is both correct and the safe direction — the lanes it
 * gates are skipped rather than run against a broken daemon.
 */
function dockerUp() {
  const res = spawnSync("docker", ["info"], {
    stdio: "ignore",
    shell: true,
    timeout: 20_000,
  });
  // A timeout kills the child and reports SIGTERM with a null status, so the
  // `status === 0` test alone would read it as "not up" by accident rather than
  // on purpose. Saying it explicitly keeps the intent legible.
  if (res.error?.code === "ETIMEDOUT" || res.signal) {
    console.warn(
      "  ! docker did not answer `docker info` within 20s — treating it as " +
        "unavailable. The daemon is running but wedged; restart Docker Desktop " +
        "if you need the db/security lanes.",
    );
    return false;
  }
  return res.status === 0;
}

// The iOS text guards, and the workflow each one answers to. Exported shape is
// deliberate: src/test/ios-guard-lane.test.ts reads this list and fails if a
// guard runs in CI and not here, which is the drift that let six of them go
// unrun locally for months.
const IOS_GUARDS = [
  ["no ungated print", "no-ungated-print.py"],
  ["no default URLSession.shared", "no-default-shared-session.py"],
  ["no raw JPEG encode", "no-raw-jpeg-encode.py"],
  ["no new bare UI strings", "no-bare-strings.py"],
  ["no force unwrap", "no-force-unwrap.py"],
  ["ATS not relaxed", "check-ats.py"],
  ["one sheet modifier per view", "check-chained-sheets.py"],
  ["AI routes on the AI session", "check-ai-session.py"],
  ["no trailing comma in a param list", "no-trailing-comma.py"],
];

const results = [];
let skipped = [];
const warnings = [];
/**
 * US-2655: local gates that are silently doing nothing because their tool is
 * absent. Not failures — the CI net still runs them — but a skip nobody sees is
 * how a gate stops being a gate.
 *
 * The pre-commit secret scan is the case that prompted this: it prints three
 * lines and exits 0 when gitleaks is missing, and those three lines scroll past
 * inside the commit output. A whole session of commits went out with no local
 * secret scan and nothing in any summary said so.
 */
const degraded = [];


// US-2788: NO TIMEOUT HERE, AND THAT IS CORRECT.
//
// `dockerUp` needed one because it is a silent PROBE: stdio "ignore", a
// sub-second expected answer, and a wedged daemon that prints nothing while it
// hangs. These two run the WORK - a build, a full vitest pass, a deno suite -
// with stdio "inherit". A legitimate run here takes minutes and the spread is
// wide, so any number large enough to be safe is too large to be useful, and a
// hang is VISIBLE because the output simply stops.
//
// The rule the three-hour lock actually teaches is not "time out every external
// call". It is "time out the ones that cannot show you they are stuck".
function run(name, cmd, opts = {}) {
  process.stdout.write(`\n\x1b[1m▶ ${name}\x1b[0m\n  $ ${cmd}${opts.cwd ? `   (in ${opts.cwd})` : ""}\n`);
  const started = Date.now();
  const r = spawnSync(cmd, { stdio: "inherit", shell: true, cwd: opts.cwd ?? root });
  const ok = r.status === 0;
  results.push({ name, ok, sec: ((Date.now() - started) / 1000).toFixed(1) });
}

// Runs a check for its REPORT rather than its verdict: a failure is surfaced
// loudly in the summary but does not fail the lane. For known-broken external
// state (a vulnerable base image) where a hard gate would be red on arrival.
function advisory(name, cmd, opts = {}) {
  process.stdout.write(`\n\x1b[1m▶ ${name}\x1b[0m \x1b[2m(advisory)\x1b[0m\n  $ ${cmd}\n`);
  const r = spawnSync(cmd, { stdio: "inherit", shell: true, cwd: opts.cwd ?? root });
  if (r.status !== 0) warnings.push(name);
}

// ── Web (Node) — mirrors ci.yml "build" job ──────────────────────────────────
if (on("web")) {
  // US-1612: cheap prd.json hygiene gate FIRST — catches a bad nextId / dep
  // cycle / dup id before the expensive lanes run.
  run("web: prd-lint", "node scripts/prd-lint.mjs");
  // CLAUDE.md is read at the start of every session, so a path that has moved
  // costs every one of them. Cheap enough to sit beside prd-lint.
  run("web: doc path refs", "node scripts/doc-refs.mjs");
  // US-2437: BEFORE eslint, deliberately. The bug that filed that story was
  // eslint linting supabase/.temp/start-secrets/ — 189 errors in generated,
  // minified code nobody wrote — which only appears once you run `supabase
  // start`, i.e. only for the people following CLAUDE.md's full-stack lanes. A
  // wall of errors in a file you did not touch reads as "my change broke
  // something"; naming the cause first is the whole point of the ordering.
  run("web: no tracked-and-gitignored files", "node scripts/check-tracked-ignored.mjs");
  // US-2444: the shape of supabase/migrations/ — no ignored paths, no duplicate
  // versions, no unexplained gap. Filesystem + git only, so it runs in the web
  // lane rather than the Docker-gated db one: the bug it was written for
  // (00122, gitignored and never committed) is invisible to a lane that applies
  // the files present, and would have gone unseen for another year behind a
  // check most runs skip.
  run("web: migrations lint", "node scripts/migrations-lint.mjs");
  run("web: script tests (prd-lint/digest)", "npm run test:scripts");
  run("web: eslint", "npm run lint");
  // US-1879: the browser extensions' zero-dep node tests (pure adapter helpers +
  // the bundled⇄hosted config sync guard) — cheap, so run before the heavy lanes.
  run("web: extension tests (condition-check)", "node scripts/test-extensions.mjs");
  run("web: tsc -b", "npx tsc -b");
  // Build BEFORE vitest: the prerender suite validates dist/, and CI runs it
  // after `npm run build`. Testing first would check a STALE dist — any newly
  // registered public route reads as "missing" until the next local build.
  run("web: production build (incl. prerender)", "npm run build");
  run("web: vitest + coverage", "npm run test:coverage");
  run("web: bundle-size budget + code-splitting", "node scripts/check-bundle-budget.mjs");
  // US-2336: the UI anti-pattern gate. Blocks on the tells the project's own
  // guidance rules out (side tabs, gradient text, nested cards); reports the
  // rest against a recorded noise baseline. Runs here rather than as a bare
  // impeccable call so one noisy rule cannot block a deploy.
  run("web: UI anti-patterns (impeccable)", "node scripts/check-ui-antipatterns.mjs");
  // US-2495: an edge lib module that NO production file imports. The audit
  // behind this has found a real defect every time a human remembered to run
  // it, which is why it now runs here instead of on memory.
  run("web: unwired edge modules", "node scripts/check-unwired-modules.mjs");
  run("web: npm audit (high)", "npm audit --audit-level=high");
}

// ── Vault (knowledge base integrity) — US-2044 ───────────────────────────────
// Fast, no Docker, no network — so it runs in the default set. --strict makes
// drift on a `type: contract` note an ERROR: those are the notes whose staleness
// actively misleads, since a stale contract gets read as authoritative and then
// implemented. Drift on every other note type stays a warning, because a commit
// touching a file often does not invalidate the prose describing it.
if (on("vault")) {
  run("vault: lint (schema, links, orphans, contract drift)", "node scripts/vault-lint.mjs --strict");
  // Regenerate-and-diff. A stale index is a silently INCOMPLETE index: notes
  // exist that nothing points at, which the orphan rule then reports as a
  // separate confusing failure. Catch the cause, not the symptom.
  run("vault: index up to date", "node scripts/vault-index.mjs --check");
  // US-2050: the two VENDOR skills exist under both .claude/skills and
  // .agents/skills. Nothing here reads the latter, but an agent tool outside
  // this repo may, so both are kept and CI asserts they stay identical —
  // updating one and forgetting the other leaves two versions of the same
  // instructions with nothing to say which is current.
  run("vault: vendor skill mirrors in sync", "node scripts/skills-sync.mjs");
  // US-2076: the SHIPPED copies of ops knowledge (in-app runbooks, rotation
  // registry) against the vault notes they were distilled from. This is the
  // copy on-call reads during an incident, and it had no guard at all.
  run("vault: shipped runbook copies vs vault", "node scripts/runbook-sync.mjs");
  // US-2630: the env reference against what the code actually reads. It sits in
  // the vault lane because that file IS a vault note, and it is the one a person
  // follows when rebuilding the stack.
  run("vault: env reference vs code", "node scripts/check-env-reference.mjs");
}

// ── Edge (Deno) — mirrors security.yml "deno-check" job ───────────────────────
if (on("edge")) {
  run("edge: deno lint", "deno lint", { cwd: edgeDir });
  // US-2378: src/tests/ is checked alongside main.ts. `deno test` type-checks
  // first, so a type error in a test file runs ZERO tests — checking the tree
  // here names the broken file instead of letting it look like a test failure.
  run("edge: deno check src/main.ts + tests", "deno check src/main.ts src/tests/", {
    cwd: edgeDir,
  });
  run("edge: deno test", "deno test --allow-net --allow-env --allow-read", { cwd: edgeDir });
  run("edge: frozen lockfile", "deno cache --frozen src/main.ts", { cwd: edgeDir });
}

// ── DB (Supabase, local throwaway stack) — mirrors db-migrations.yml ──────────
if (on("db")) {
  if (!dockerUp()) {
    skipped.push("db: Docker daemon is not running — start Docker Desktop, then `npm run verify:db`.");
  } else {
    // config.toml interpolates the Google OAuth creds + Turnstile captcha secret
    // via env(); the CLI rejects an enabled provider/captcha with empty values.
    // Mirror db-migrations.yml's dummies so the local db lane works out of the box
    // (migrations only — neither handshake is exercised). Don't clobber real values.
    process.env.SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID ??= "ci-dummy-client-id.apps.googleusercontent.com";
    process.env.SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET ??= "ci-dummy-secret";
    process.env.SUPABASE_AUTH_CAPTCHA_SECRET ??= "1x0000000000000000000000000000000AA";
    run("db: supabase db start (apply migrations)", "supabase db start");
    run("db: supabase db reset --no-seed (re-apply from zero)", "supabase db reset --no-seed");
    // US-1927 AC3: rls-guard_test.ts pins the policy SOURCE form; this pins the
    // PLAN. A policy can read correctly and still be re-evaluated per row, so
    // the two are different assertions and only this one answers the story.
    // Green today, so it gates.
    run("db: RLS auth.uid() InitPlan (US-1927)", "node scripts/db-rls-initplan-check.mjs");
    // US-2663: the lane above APPLIES every migration and never CALLS anything
    // it creates. `CREATE FUNCTION` does not validate a plpgsql body, so
    // revenue_dashboard installed cleanly while selecting a column that has
    // never existed — and raised on every call for months with every gate
    // green. This one executes each RPC the edge invokes, inside a transaction
    // that is always rolled back.
    run("db: RPC bodies resolve (US-2663)", "node scripts/check-rpc-column-refs.mjs");
    // US-2662: the same lesson one level up. Stopping an impersonation called a
    // GoTrue route that does not exist on this version, so nothing was ever
    // revoked — and the test guarding it asserted the route's SOURCE contained
    // the call, which was true the entire time the feature did nothing. This one
    // seeds a session, revokes it, and fails if the rows are still there.
    run("db: session revocation revokes (US-2662)", "node scripts/check-session-revocation.mjs");
    // US-2403: a denied function call SEGFAULTs the Supabase Postgres image and
    // restarts the whole database. ADVISORY, not a gate, and deliberately so:
    // the stock image is vulnerable today, so gating here would be red on every
    // migration PR from the moment it lands — and a permanently red check gets
    // switched off, which is how the guard stops guarding. It flips to `run()`
    // the moment the image or the supautils.hint_roles config is fixed; that
    // flip is step one of the mitigation, not a follow-up.
    advisory(
      "db: denied-RPC crash (US-2403)",
      "node scripts/db-denied-rpc-crash-check.mjs",
    );
  }
}

// ── iOS source guards — the part of iOS CI that needs no Mac ─────────────────
//
// Swift cannot be COMPILED here, and that is not what these check. Six scripts
// read the iOS sources as text: an ungated print() that would put a token in a
// device log, a URLSession.shared that bypasses the pinned session, a raw JPEG
// encode outside PhotoCompressor, a bare UI string that can never be
// translated, a force unwrap, and an ATS relaxation in the Release plist. All
// six are pure text scans over ios/, they take about a second together, and
// they were the only iOS safety net a Windows checkout could ever have had.
//
// THEY WERE NEVER WIRED UP, and the reason is worth keeping: CLAUDE.md recorded
// them as CI-only "because there is no python3 on the Windows dev box". True as
// stated, and it hid the real situation — Python 3.13 is installed here, under
// the name `python`. Six guards sat one string away from running, and one of
// them was ported to a vitest file (src/test/ios-ungated-print.test.ts) to work
// around a problem that was a naming difference. That port stays: it needs no
// Python at all, and its parity case is what stops the two scanning different
// trees.
//
// In the DEFAULT set rather than opt-in, unlike the Android lane, because it is
// a second rather than minutes. A checkout with no Python, or no ios/, skips
// with a reason instead of failing.
if (on("ios")) {
  const iosDir = resolve(root, "ios");
  if (!existsSync(iosDir)) {
    skipped.push("ios: no ios/ directory in this checkout");
  } else {
    // Node, not Python, so it runs on a checkout where the .py guards skip.
    // Different question from the text guards too: they ask whether the code is
    // WRITTEN safely, this asks whether anyone can REACH it.
    run("ios: no unreachable types", "node scripts/check-ios-orphans.mjs");

    const py = resolvePython();
    if (!py) {
      skipped.push(
        "ios: no Python 3 on PATH (tried python3, python, py) — the ios/Scripts/*.py guards need one",
      );
    } else {
      // Invoked from the repo root with the ios/Scripts/… path, exactly as
      // ios-ci.yml and static-analysis.yml invoke them, so a script that
      // resolves a path relative to the working directory behaves the same
      // here as it does there.
      for (const [label, script] of IOS_GUARDS) {
        run(`ios: ${label}`, `${py} ios/Scripts/${script}`);
      }
    }
  }
}

// ── Android — mirrors android-ci.yml "build-and-test" (US-2502) ──────────────
//
// Opt-in (`--android` / `npm run verify:android`) rather than part of the
// default set, because a cold run is minutes of Kotlin + KSP and the default
// set has to stay fast enough that people actually run it. The pre-push hook
// turns it on automatically when the push contains android/** changes, which is
// the moment it matters.
//
// Ordered cheapest first: the .py source guards are seconds, spotless and detekt
// are tens of seconds, and everything after that is a build. A formatting
// failure should not cost the eight minutes assembleRelease takes to surface.
if (on("android")) {
  const androidDir = resolve(root, "android");
  // Imported lazily so a web-only run never pays for it, and so verify.mjs
  // still works in a checkout with no android/ directory.
  const tc = (await import("../android/scripts/toolchain.mjs")).resolveToolchain();
  if (!tc.ok) {
    skipped.push(
      `android: ${tc.problems.join(" ")} Fix with \`node android/scripts/doctor.mjs --fix\`.`,
    );
  } else {
    // spawnSync inherits process.env, so setting these here is what puts the
    // right JDK in front of Gradle. Without it AGP picks whatever `java` PATH
    // resolves to and fails with the bare version string as its whole error.
    Object.assign(process.env, tc.env);
    // ABSOLUTE, and quoted. `gradlew.bat` alone is what this used to run, with
    // cwd set to android/ — and cmd.exe does not resolve a bare command name
    // from the current directory, so every Gradle step in this lane died
    // instantly with "'gradlew.bat' is not recognized" and reported 0.0s.
    // Ten checks "failed" without ever starting, which reads exactly like ten
    // broken builds. The POSIX form worked because "./gradlew" is already a
    // path; this is the one platform where the difference matters, and it is
    // the platform the lane exists for.
    // Quoted by hand rather than with JSON.stringify: that escapes every
    // backslash, so the command line carries C:\\Users\\… — which Windows
    // tolerates and nothing else should have to.
    const gw = `"${resolve(androidDir, process.platform === "win32" ? "gradlew.bat" : "gradlew")}"`;
    const py = tc.python;
    const a = { cwd: androidDir };

    // US-1391/1393/2368: the source guards. Seconds each, and they catch what a
    // compiler cannot -- a token in logcat, a string that can never be
    // translated, a format-arity mismatch that throws in one language only.
    run("android: no ungated logging", `${py} scripts/no-ungated-log.py`, a);
    run("android: no bare strings (scoped)", `${py} scripts/no-bare-strings.py`, a);
    run("android: string format arity", `${py} scripts/check-string-formats.py`, a);
    // US-2502: a Room version whose schema JSON was never committed cannot be
    // migration-tested, ever. Catch it while the file can still be produced.
    run("android: room schemas exported", "node scripts/check-room-schemas.mjs", a);

    run("android: format (spotless/ktlint)", `${gw} :app:spotlessCheck`, a);
    run("android: static analysis (detekt)", `${gw} :app:detekt`, a);
    run("android: lint (warnings as errors)", `${gw} :app:lintDebug`, a);
    run("android: unit tests", `${gw} :app:testDebugUnitTest`, a);
    run("android: coverage floor (kover)", `${gw} :app:koverVerifyDebug`, a);
    // US-2502: rendered-UI diffs. ADVISORY, matching the `continue-on-error` on
    // the CI step — see the comment on it in android-ci.yml for the condition
    // that flips both. Locally it is the more useful of the two runs: the
    // goldens were recorded on this machine, so a diff here is a real visual
    // change rather than a font difference between a checkout and a runner.
    advisory("android: screenshots (roborazzi)", `${gw} :app:verifyRoborazziDebug`, a);
    run("android: assembleDebug", `${gw} :app:assembleDebug`, a);
    // US-1391 AC3: the widget, share target and deep links are reachable only
    // through the merged manifest, so a merge that drops one is a green build
    // and a missing feature.
    run("android: merged manifest keeps system components", "node scripts/check-merged-manifest.mjs", a);
    // Compiles androidTest without an emulator: a broken test source fails
    // here rather than only in the non-blocking instrumented lane.
    run("android: instrumented sources compile", `${gw} :app:assembleDebugAndroidTest`, a);
    // R8 + the proguard rules + the signing config. Unsigned locally, which
    // still proves a rule did not strip something the app needs at runtime.
    run("android: assembleRelease (R8)", `${gw} :app:assembleRelease`, a);
    run("android: bundleRelease (the shipped artifact)", `${gw} :app:bundleRelease`, a);
    // US-2150: the self-test first, so a size gate that only ever sees passing
    // input cannot report PASS forever.
    run(
      "android: per-ABI download size",
      `${py} scripts/abi-size-report.py --self-test && ${py} scripts/abi-size-report.py`,
      a,
    );
  }
}

// ── Security (Trivy image scan) — mirrors security.yml "trivy-edge-image" ─────
if (on("security")) {
  if (!dockerUp()) {
    skipped.push("security: Docker daemon is not running — start Docker Desktop, then `npm run verify:security`.");
  } else {
    run("security: npm audit (high)", "npm audit --audit-level=high");
    run("security: build edge image", "docker build -t gradethread-edge:scan services/edge-functions");
    run(
      "security: trivy image (HIGH/CRITICAL, fixed-only)",
      "trivy image --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 gradethread-edge:scan",
    );
  }
}

// ── E2E (Playwright) — mirrors ci.yml "e2e" job ──────────────────────────────
if (on("e2e")) {
  run("e2e: playwright (builds + runs against preview)", "npm run build && npm run e2e");
}

// ── Summary ──────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
// US-2655: report the local gates that are present-but-inert. These do not
// fail the run — CI still runs both — but the whole point of a local gate is
// to be the thing that catches it FIRST, and one that is quietly absent is
// worth a line in the summary rather than three lines inside a commit.
degraded.push(...inertLocalGates());

process.stdout.write("\n\x1b[1m──────── verify summary ────────\x1b[0m\n");
for (const r of results) {
  const mark = r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  process.stdout.write(`  ${mark} ${r.name} \x1b[2m(${r.sec}s)\x1b[0m\n`);
}
for (const s of skipped) process.stdout.write(`  \x1b[33m⚠ skipped\x1b[0m ${s}\n`);
for (const w of warnings) process.stdout.write(`  \x1b[33m⚠ advisory FAILED (does not block)\x1b[0m ${w}\n`);
for (const d of degraded) {
  process.stdout.write(`  \x1b[33m⚠ local gate inert\x1b[0m ${d}\n`);
}

// Released explicitly as well as on 'exit': the handler covers a crash, but
// naming it here is what tells the next reader the lock has an owner.
releaseLock();

if (failed.length) {
  process.stdout.write(`\n\x1b[31m\x1b[1m${failed.length} check(s) failed:\x1b[0m ${failed.map((f) => f.name).join(", ")}\n`);
  process.exit(1);
}
process.stdout.write(`\n\x1b[32m\x1b[1mAll ${results.length} check(s) passed.\x1b[0m${skipped.length ? ` (${skipped.length} skipped)` : ""}\n`);
