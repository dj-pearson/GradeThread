// GradeThread unified extension — the worker tab (US-3061).
//
// Zero-dependency node script: throws on drift.
//
// WHAT THIS PROTECTS. The worker tab is the honest answer to cloud automation:
// the queue drains all day, in the seller's own browser, with nobody holding a
// marketplace password. Every way it can go wrong is silent, and three of them
// are worse than the feature not existing:
//
//   1. A DRAIN THAT RESUMES ITSELF PAST A HUMAN CHECK. The ADR
//      (vault/60-decisions/adr-no-server-side-marketplace-automation.md §3.2)
//      refuses to answer a CAPTCHA. A drain that waits one timeout and opens the
//      same challenged page again is answering it by retrying, and the
//      marketplace sees a machine doing exactly that. Only the seller clears it.
//   2. ACTING IN A TAB WE DID NOT OPEN. Tab ids are recycled by the browser, so
//      an owned-tab list that only grows will eventually match a tab the SELLER
//      opened — and then this extension closes, focuses or fills someone's own
//      Poshmark tab. Ownership is the only check standing there.
//   3. REPLACING THE ALARM. The 5-minute SWEEP_ALARM is what serves every seller
//      who never opens this tab, which is most of them most of the time. A
//      "the worker tab handles it now" refactor turns the feature off for them
//      with no error anywhere. Same trap as drain-nudge.test.cjs rule 3.
//
// Plus the two structural ones: worker.html must not be reachable from web
// content, and a `list` tab must never be closed on completion — it holds a
// filled form the seller still has to submit.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(dir, ...p), "utf8");

const BG = read("background.js");
const WORKER_JS = read("worker.js");
const WORKER_HTML = read("worker.html");
const POPUP_JS = read("popup.js");
const POPUP_HTML = read("popup.html");
const OPTIONS_JS = read("options.js");
const MANIFEST = JSON.parse(read("manifest.json"));

// The pure state machine, loaded the way queue-view.test.cjs loads its module.
const root = {};
new Function("self", read("queue", "worker-state.js"))(root);
const W = root.GT_WORKER_STATE;
assert.ok(W, "queue/worker-state.js must assign self.GT_WORKER_STATE");

const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);

// ── 1. the cadence ─────────────────────────────────────────────────────────
{
  assert.strictEqual(W.DRAIN_INTERVAL_MS, 60 * 1000, "the worker tab drains every 60s");

  // A fresh state drains IMMEDIATELY rather than waiting out the first minute.
  // A seller who just opened the tab because something is stuck should not have
  // to sit through a full interval to find out nothing happens.
  assert.strictEqual(W.shouldDrain(W.initialState(NOW), NOW), true, "first tick drains");

  let s = W.noteDrain(W.initialState(NOW), "ok", NOW);
  assert.strictEqual(W.shouldDrain(s, NOW + 59 * 1000), false, "59s in: not yet");
  assert.strictEqual(W.shouldDrain(s, NOW + 60 * 1000), true, "60s in: go");
  assert.strictEqual(W.countdownSeconds(s, NOW + 20 * 1000), 40, "countdown counts down");
  assert.match(W.statusLine(s, NOW + 20 * 1000), /next in 40s/, "the status line says when");

  // Stop is the seller's, and it stops everything.
  assert.strictEqual(W.shouldDrain(W.stop(s), NOW + 5 * 60 * 1000), false, "stopped stays stopped");
  assert.strictEqual(
    W.shouldDrain(W.start(W.stop(s), NOW), NOW + 5 * 60 * 1000),
    true,
    "start resumes the cadence",
  );
}

// ── 2. a pause is cleared by the seller and by nobody else ─────────────────
{
  const base = W.noteDrain(W.initialState(NOW), "ok", NOW);
  const paused = W.pause(base, { reason: "human_check", platform: "poshmark" }, NOW);

  assert.strictEqual(W.shouldDrain(paused, NOW + 60 * 1000), false, "paused: no drain at 60s");
  // THE ONE THAT MATTERS. Not after a minute, not after ten, not after an hour.
  assert.strictEqual(
    W.shouldDrain(paused, NOW + 60 * 60 * 1000),
    false,
    "a pause must NEVER time out into a resume — that is answering a human " +
      "check by retrying it",
  );
  assert.strictEqual(W.countdownSeconds(paused, NOW), null, "a paused worker has no next drain");

  // resume() refuses unless the caller says the seller asked. The argument is
  // the point: a future caller has to state it rather than discover that
  // resume(state) quietly works.
  assert.ok(W.resume(paused, false).pause, "resume without the seller changes nothing");
  assert.ok(W.resume(paused).pause, "resume with no argument changes nothing");
  assert.strictEqual(W.resume(paused, true).pause, null, "the seller clears it");

  // Stop must not launder a pause into a clean start.
  assert.ok(W.start(W.stop(paused), NOW).pause, "stop then start does not clear a pause");

  // Both report shapes are recognised. Missing either leaves the drain running
  // into a challenged page, which is failure mode 1.
  assert.strictEqual(
    W.pauseFor({ loginWall: true, platform: "mercari" }).reason,
    "login_wall",
    "lister/common.js sends { loginWall: true }",
  );
  assert.strictEqual(
    W.pauseFor({ reason: "human_check", platform: "poshmark" }).reason,
    "human_check",
    "lister/engagement.js sends { reason: 'human_check' }",
  );
  assert.strictEqual(W.pauseFor({ ok: false, error: "nope" }), null, "an ordinary failure is not a pause");
  assert.strictEqual(W.pauseFor(null), null, "a missing notice is not a pause");

  // The seller is told which tab and what to do, in words, not a code.
  const line = W.statusLine(paused, NOW);
  assert.match(line, /human check/i, "the pause line names what was asked");
  assert.match(line, /Resume/, "the pause line names the way out");
}

// ── 3. tab ownership ───────────────────────────────────────────────────────
{
  assert.strictEqual(W.ownsTab([7, 9], 9), true);
  assert.strictEqual(W.ownsTab([7, 9], 8), false, "a tab we did not open is not ours");
  assert.strictEqual(W.ownsTab([], 9), false, "an empty list owns nothing");
  assert.strictEqual(W.ownsTab([7], null), false, "a missing id is never ours");
  assert.deepStrictEqual(W.addOwnedTab([7], 7), [7], "adding twice does not duplicate");
  assert.deepStrictEqual(W.removeOwnedTab([7, 9], 7), [9]);

  // Failure mode 2: without the prune, a recycled id eventually reads as ours.
  assert.deepStrictEqual(
    W.pruneOwnedTabs([7, 9, 11], [9, 11, 40]),
    [9, 11],
    "ids whose tab is gone are dropped, so a recycled id cannot match",
  );

  // Stale tabs are the ones well past their deadline, and only ours.
  const jobs = {
    a: { tabId: 9, deadlineAt: NOW - 11 * 60 * 1000 },
    b: { tabId: 11, deadlineAt: NOW - 60 * 1000 },
    c: { tabId: 500, deadlineAt: NOW - 60 * 60 * 1000 }, // not ours
  };
  assert.deepStrictEqual(
    W.staleTabs(jobs, [9, 11], NOW),
    [9],
    "only an owned tab more than ten minutes past its deadline is reported",
  );
  assert.strictEqual(W.STALE_TAB_GRACE_MS, 10 * 60 * 1000, "the grace is ten minutes");
}

// ── 4. the background enforces all of it ───────────────────────────────────
{
  // The drain refuses while paused, and it refuses BEFORE it claims a row —
  // claiming and then refusing would mark rows as running that never ran.
  const drain = BG.slice(BG.indexOf("async function drainQueue()"), BG.indexOf("\n}\n", BG.indexOf("async function drainQueue()")));
  assert.ok(drain.includes("await workerPaused()"), "drainQueue must check the pause");
  assert.ok(
    drain.indexOf("await workerPaused()") < drain.indexOf('queueFetch("/claim"'),
    "the pause is checked BEFORE anything is claimed",
  );
  assert.ok(drain.includes("rememberWorkerTab(tab.id)"), "a tab the drain opens is recorded as ours");

  // Failure mode 3: the 5-minute sweep survives.
  assert.ok(BG.includes('const SWEEP_ALARM = "gt-lister-sweep"'), "the sweep alarm still exists");
  assert.ok(
    /SWEEP_ALARM[\s\S]{0,400}?drainQueue\(\)/.test(BG) || BG.includes("void drainQueue();"),
    "the sweep still calls the drain — the worker tab is an addition, never a replacement",
  );

  // Both notice paths pause the worker.
  assert.ok(
    BG.includes("await pauseWorker(msg.notice, job.tabId)"),
    "a login wall pauses the worker and names its tab",
  );
  assert.ok(
    /GT_SYNC_HUMAN_CHECK[\s\S]{0,400}?pauseWorker\(/.test(BG),
    "a sold-sync human check pauses the worker",
  );

  // resumeWorker is the only clear, and nothing schedules it.
  assert.ok(BG.includes("async function resumeWorker()"), "resumeWorker exists");
  const resumeCallers = BG.split("resumeWorker(").length - 1;
  assert.strictEqual(
    resumeCallers,
    2,
    "resumeWorker must have exactly one definition and one caller (the seller's " +
      "GT_WORKER_RESUME). A timer or a startup hook calling it is the ADR §3.2 break.",
  );
  assert.ok(
    !/setTimeout\([^)]*resumeWorker/.test(BG) && !/alarms[\s\S]{0,200}resumeWorker/.test(BG),
    "nothing may schedule a resume",
  );

  // Focus refuses a foreign tab. This is the message-borne tab id case.
  const focus = BG.slice(BG.indexOf('case "GT_WORKER_FOCUS"'), BG.indexOf('case "GT_WORKER_OPEN"'));
  assert.ok(focus.includes("await workerOwnsTab(msg.tabId)"), "focus checks ownership");
  assert.ok(focus.includes('reason: "not-ours"'), "a foreign tab is refused by name");
  assert.ok(
    focus.indexOf("workerOwnsTab") < focus.indexOf("tabs.update"),
    "ownership is checked BEFORE the tab is touched",
  );

  // One job at a time. Six marketplace tabs opening at once in the browser the
  // seller is also using is not a feature, and the worker tab does not get a
  // wider lane than the alarm just because nobody is watching.
  const JOBS = fs.readFileSync(path.join(dir, "lister", "job-store.js"), "utf8");
  assert.ok(
    /var DRAIN_MAX_CONCURRENT = 1;/.test(JOBS),
    "the drain runs at most one job at a time",
  );

  // US-3061 on a phone: a platform nobody has driven on the mobile DOM is
  // refused with a sentence, not attempted. A desktop selector that misses on
  // mobile fills nothing and reports nothing wrong, which is the US-2165 case.
  assert.ok(BG.includes("async function isAndroidRuntime()"), "the runtime is probed, not guessed");
  assert.ok(
    /getPlatformInfo\(\)/.test(BG),
    "Android is detected with runtime.getPlatformInfo, never a user-agent string",
  );
  assert.ok(
    drain.includes("mobileFlowAllowed(self.GT_LISTER_SELECTORS, row.platform)"),
    "the drain asks whether this platform is known to work on a phone",
  );
  assert.ok(
    drain.indexOf("mobileFlowAllowed") < drain.indexOf("ext.tabs.create({ url: target"),
    "the refusal happens BEFORE a tab is opened",
  );
  assert.ok(
    drain.includes("mobileUnsupported: true"),
    "the row is completed with a reason rather than left to time out",
  );
  const SEL = fs.readFileSync(path.join(dir, "lister", "selectors.js"), "utf8");
  assert.strictEqual(
    (SEL.match(/mobile: \{ enabled: /g) || []).length,
    5,
    "every listed platform states whether its form works on a phone",
  );

  // A list tab is never closed: it holds a form the seller still has to submit.
  assert.ok(
    /const WORKER_CLOSABLE_KINDS = \{ delist: true, revise: true \};/.test(BG),
    "only delist and revise close their tab",
  );
  const closer = BG.slice(BG.indexOf("async function closeWorkerTabForJob"), BG.indexOf("async function openWorkerTab"));
  assert.ok(closer.includes("await workerOwnsTab(job.tabId)"), "closing checks ownership");
  assert.ok(closer.includes("result.ok !== true"), "a failed job's tab is left for the seller");
}

// ── 5. worker.html is not reachable from web content ───────────────────────
{
  assert.ok(
    !MANIFEST.web_accessible_resources,
    "the manifest must declare no web_accessible_resources — worker.html becoming " +
      "one would let any page navigate to it",
  );
  assert.ok(
    !/worker\.html/.test(JSON.stringify(MANIFEST.content_scripts || [])),
    "no content script references worker.html",
  );
  // The two openers are the popup and the options page, and both go through the
  // background so there is one path to tabs.create for this page.
  assert.ok(BG.includes('const WORKER_PAGE = "worker.html"'), "the background owns the page URL");
  assert.ok(
    /ext\.tabs\.create\(\{ url: url, pinned: true/.test(BG),
    "the worker tab is created pinned",
  );
  assert.ok(POPUP_JS.includes('send({ type: "GT_WORKER_OPEN" })'), "the popup asks the background");
  // The literal, not the word: both files mention worker.html in a comment
  // explaining why they do NOT open it, and a bare substring match reads that
  // as the violation it is documenting.
  assert.ok(
    !/["'`]worker\.html["'`]/.test(POPUP_JS),
    "the popup must not build the URL itself",
  );
  assert.ok(
    !/["'`]worker\.html["'`]/.test(OPTIONS_JS),
    "the options page must not build the URL itself",
  );
  assert.ok(POPUP_HTML.includes('id="queueWorker"'), "the popup offers the button");
  assert.ok(
    /Keep GradeThread working/.test(POPUP_HTML),
    "the button says what it does in the seller's words",
  );
}

// ── 6. the page: keep-alive, reconnect, and no navigation ──────────────────
{
  assert.ok(WORKER_JS.includes("ext.runtime.connect({ name: W.PORT_NAME })"), "the page holds a port");
  assert.ok(
    /onDisconnect\.addListener\(function \(\) \{\s*port = null;\s*scheduleReconnect\(\);/.test(WORKER_JS),
    "a dropped port reconnects — MV3 restarts the service worker several times a " +
      "day, and a tab that stops keeping it alive looks identical to one that is",
  );
  assert.ok(
    /setInterval\(function \(\) \{ void tick\(\); \}, TICK_MS\)/.test(WORKER_JS),
    "the page ticks on an interval",
  );
  assert.ok(WORKER_JS.includes('send({ type: "GT_QUEUE_RUN_NOW" })'), "it drains through the existing path");
  assert.ok(
    !/tabs\.create|location\.href\s*=|window\.open|location\.assign/.test(WORKER_JS),
    "the worker page never navigates or opens a tab itself — every target is the " +
      "background's, checked against lister-guard's host pinning (US-1876)",
  );
  assert.ok(
    WORKER_JS.includes('send({ type: "GT_WORKER_RESUME" })'),
    "Resume is a seller action sent to the background",
  );
  assert.ok(
    !/setTimeout[\s\S]{0,200}GT_WORKER_RESUME/.test(WORKER_JS),
    "nothing on the page may schedule a resume",
  );
  // The page reuses the popup's shaping rather than growing a second one.
  assert.ok(WORKER_HTML.includes("queue/queue-view.js"), "the page loads the shared view model");
  assert.ok(WORKER_JS.includes("QUEUE_VIEW.groupRows"), "the page renders the same three groups");
  // The three group labels are queue-view.js's, and a copy here would be the
  // popup and the worker disagreeing about what "Needs you" means.
  assert.ok(
    !/Needs you|Running now|Waiting/.test(WORKER_JS),
    "the page must not restate the group labels",
  );
}

// ── 7. the autostart option ────────────────────────────────────────────────
{
  assert.ok(OPTIONS_JS.includes("gtWorkerAutostart"), "the option is wired");
  assert.ok(
    !/storage\.sync\.(get|set|remove)/.test(OPTIONS_JS),
    "the option is per machine — storage.sync would open the tab on every device",
  );
  assert.ok(
    /gtWorkerAutostart[\s\S]{0,300}?storage\.local\.remove\("gtWorkerAutostart"\)/.test(OPTIONS_JS),
    "off removes the key rather than storing false, so default and off are one state",
  );
  assert.ok(
    /onStartup[\s\S]{0,400}?WORKER_AUTOSTART_KEY[\s\S]{0,200}?openWorkerTab\(\)/.test(BG),
    "startup opens the tab only when the option is on",
  );
  assert.ok(
    /WORKER_AUTOSTART_KEY\] === true/.test(BG),
    "the autostart check is strict — an absent key must not read as on",
  );
}

// ── 8. the manifest carries the new dep, and Firefox for Android stays ─────
{
  const scripts = MANIFEST.background.scripts;
  assert.ok(
    scripts.includes("queue/worker-state.js"),
    "Firefox has no importScripts: the dep must be in background.scripts too",
  );
  assert.ok(
    scripts.indexOf("queue/worker-state.js") < scripts.indexOf("background.js"),
    "the dep loads before background.js reads self.GT_WORKER_STATE",
  );
  const android = MANIFEST.browser_specific_settings &&
    MANIFEST.browser_specific_settings.gecko_android;
  assert.ok(android, "the gecko_android block is kept — it is what lets a phone drain the queue");
  assert.strictEqual(android.strict_min_version, "142.0", "Firefox for Android 142+");
}

console.log(
  "worker-tab.test.cjs: 60s cadence with an immediate first tick, a pause no timer " +
    "can clear, ownership that prunes recycled ids, a list tab never closed, " +
    "worker.html unreachable from web content, a port that reconnects, and the " +
    "5-minute sweep still in place",
);
