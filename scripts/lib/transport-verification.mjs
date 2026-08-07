// US-1882 — web↔extension TRANSPORT verification mechanism.
//
// AC4 reads "Chromium keeps using externally_connectable (no regression); Firefox
// seller flows verified end-to-end on Poshmark". The first half is now a vitest
// (src/test/lister-transport-selection.test.ts). The second half needs two real
// browsers, a real extension install and a real Poshmark account, so no agent can
// satisfy it — but the COMPLETABLE half of a manual criterion is the measurement,
// and stopping at "a human must do it" without leaving that human anything to do
// it with is the mistake US-1880 made twice.
//
// So this builds a DevTools script the operator pastes into the console on
// gradethread.com before running the seller flow. Two design rules decide its
// shape:
//
//  1. It OBSERVES; it never re-implements. It wraps window.postMessage and
//     chrome.runtime.sendMessage and then gets out of the way, so what it reports
//     is what the shipped src/lib/lister-extension.ts actually did during a real
//     "Send to extension". There is no second copy of the transport preference to
//     rot — which is the failure mode of a checklist that describes the code.
//  2. It measures the OUTCOME, not the configuration. "The bridge marker is
//     present" is a config reading and a page can have it while every job still
//     leaves over the wrong transport; "this GT_LISTER_LIST for poshmark left over
//     the bridge, its correlation id came back, and the result said filled" is the
//     thing AC4 is asking about.
//
// The verdict is derived from what was AVAILABLE, not from the user agent: when
// externally_connectable exists the job must ride it (that is the Chromium
// no-regression rule), and when it does not the bridge must carry it. So the same
// snippet, pasted in either browser, checks the rule that browser is subject to.
//
// Pure text transforms, no fs — the CLI (scripts/transport-verify.mjs) does the
// I/O and the test (scripts/transport-verification.test.mjs) EXECUTES the
// generated source against stub windows, because a verification tool nothing runs
// is one that reports PASS forever.

/** The message types that constitute a seller job (the thing AC4 is about). */
export const JOB_TYPES = ["GT_LISTER_LIST", "GT_LISTER_DELIST"];

/**
 * The protocol tokens this tool measures, and the shipped file that defines them.
 * Pinned so a rename of the bridge protocol breaks the TOOL BUILD rather than
 * producing a snippet that politely observes a protocol nobody speaks any more.
 */
export const BRIDGE_TOKENS = ["data-gt-ext-bridge", "__gtExtReq", "__gtExtRes", "__gtExtPush"];

export function assertBridgeSource(bridgeSrc) {
  if (typeof bridgeSrc !== "string" || !bridgeSrc.trim()) {
    throw new Error("bridgeSrc must be the real extension-unified/gt-bridge.js source");
  }
  const missing = BRIDGE_TOKENS.filter((t) => !bridgeSrc.includes(t));
  if (missing.length) {
    throw new Error(
      `extension-unified/gt-bridge.js no longer declares: ${missing.join(", ")} — ` +
        "the bridge protocol changed and this verification tool would measure the wrong thing",
    );
  }
}

const SNIPPET_BODY = String.raw`
  var OK = "PASS", NO = "FAIL", MEH = "WARN";

  var state = {
    startedAt: new Date().toISOString(),
    userAgent: (window.navigator && window.navigator.userAgent) || "",
    topFrame: null,
    marker: false,
    runtimeAvailable: false,
    observing: { post: false, runtime: null },
    requests: [],
    pushes: [],
    listed: [],
    strayReplies: 0,
  };

  // ── facts, captured BEFORE anything is wrapped ────────────────────────────
  try { state.topFrame = window.top === window; } catch (e) { state.topFrame = false; }
  try {
    var el = window.document && window.document.documentElement;
    state.marker = !!(el && el.getAttribute("data-gt-ext-bridge") === "1");
  } catch (e) { state.marker = false; }
  var chromeObj = window.chrome;
  var runtime = chromeObj && chromeObj.runtime;
  state.runtimeAvailable = !!(runtime && typeof runtime.sendMessage === "function");

  var seq = 0;
  function record(transport, message, id) {
    var entry = {
      n: ++seq,
      transport: transport,
      id: id || null,
      type: (message && message.type) || "",
      platform: (message && message.payload && message.payload.platform) || null,
      clientRef: (message && message.clientRef) || null,
      response: null,
      via: null,
    };
    state.requests.push(entry);
    return entry;
  }

  function settle(entry, response, via) {
    if (!entry) return;
    var r = response == null ? { ok: false, error: "empty response" } : response;
    if (entry.response) {
      // The page's own rule (US-1874, and it holds over both transports): a
      // transportError does NOT settle a job. The port died; the job is still
      // running; the durable push carries the real outcome. So a push may replace
      // a transport error, and nothing else may replace anything.
      if (!(entry.response.transportError === true && via === "push")) return;
    }
    if (r.transportError === true) entry.transportErrors = (entry.transportErrors || 0) + 1;
    entry.response = r;
    entry.via = via;
  }

  function findById(id) {
    for (var i = state.requests.length - 1; i >= 0; i--) {
      if (state.requests[i].id === id) return state.requests[i];
    }
    return null;
  }

  function findByClientRef(ref) {
    for (var j = state.requests.length - 1; j >= 0; j--) {
      if (state.requests[j].clientRef === ref) return state.requests[j];
    }
    return null;
  }

  // ── observers ─────────────────────────────────────────────────────────────
  //
  // The page's own sends are what we measure. Wrapping fails CLOSED: an
  // unwrappable transport is reported as unobservable rather than as "quiet",
  // because "no job seen" and "could not see the job" must not read the same.
  var originalPost = window.postMessage;
  try {
    window.postMessage = function (data, targetOrigin, transfer) {
      try {
        if (data && data.__gtExtReq === true && typeof data.id === "string") {
          record("bridge", data.message, data.id);
        }
      } catch (e) { /* never break the page's own send */ }
      return originalPost.call(window, data, targetOrigin, transfer);
    };
    state.observing.post = window.postMessage !== originalPost;
  } catch (e) {
    state.observing.post = false;
  }

  if (state.runtimeAvailable) {
    var originalSend = runtime.sendMessage;
    try {
      runtime.sendMessage = function (extensionId, message, callback) {
        var entry = null;
        try { entry = record("externally_connectable", message, null); } catch (e) {}
        var wrapped = callback;
        if (typeof callback === "function") {
          wrapped = function (response) {
            try {
              var lastError = runtime.lastError;
              settle(
                entry,
                lastError
                  ? { ok: false, transportError: true, error: String(lastError.message || "port closed") }
                  : response,
                "callback"
              );
            } catch (e) {}
            return callback.apply(this, arguments);
          };
        }
        return originalSend.call(runtime, extensionId, message, wrapped);
      };
      state.observing.runtime = runtime.sendMessage !== originalSend;
    } catch (e) {
      state.observing.runtime = false;
    }
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var d = event.data;
    if (!d) return;
    if (d.__gtExtRes === true) {
      var entry = findById(d.id);
      if (entry) settle(entry, d.response, "reply");
      else state.strayReplies++;
      return;
    }
    if (d.__gtExtPush === true) {
      state.pushes.push({ type: d.type || "", clientRef: d.clientRef || null });
      if (d.type === "GT_LISTER_LISTED") {
        state.listed.push({ platform: d.platform, itemId: d.itemId, listingUrl: d.listingUrl });
      }
      if (d.clientRef) settle(findByClientRef(d.clientRef), d.result, "push");
    }
  });

  // ── the report ────────────────────────────────────────────────────────────
  function browserFamily() {
    var ua = state.userAgent;
    if (/Firefox\//.test(ua)) return "firefox";
    if (/Edg\//.test(ua)) return "edge";
    if (/Chrome\//.test(ua)) return "chromium";
    return "unknown";
  }

  function jobs() {
    var out = [];
    for (var i = 0; i < state.requests.length; i++) {
      if (JOB_TYPES.indexOf(state.requests[i].type) >= 0) out.push(state.requests[i]);
    }
    return out;
  }

  function report() {
    var rows = [];
    function line(status, check, detail) {
      rows.push({ status: status, check: check, detail: detail == null ? "" : String(detail) });
    }

    // 0. Can we see anything at all?
    var observable = state.observing.post && state.observing.runtime !== false;
    line(observable ? OK : NO, "transport observers installed",
      "postMessage " + (state.observing.post ? "wrapped" : "NOT wrapped") +
      ", externally_connectable " +
      (state.observing.runtime === null ? "absent (expected on Firefox)"
        : state.observing.runtime ? "wrapped" : "NOT wrappable — this run cannot see runtime sends"));

    // 1. Is the bridge content script actually in the page?
    line(state.marker ? OK : NO, "bridge content script installed",
      state.marker ? "data-gt-ext-bridge=1"
        : "marker absent — the extension is not installed, or Firefox has not been " +
          "granted gradethread.com yet (US-1881), or this is a framed page");
    if (state.topFrame === false) {
      line(NO, "top-level frame",
        "this page is framed — gt-bridge.js refuses to install in a frame (US-1882 AC3); " +
        "run the check in the top-level tab");
    }

    // 2. Did a seller job happen?
    var js = jobs();
    line(js.length ? OK : NO, "seller job observed",
      js.length ? js.length + " job(s): " + js.map(function (j) { return j.type; }).join(", ")
        : "none yet — run FlipDesk -> Send to extension, then call report() again");
    if (!js.length) return finish(rows, null, null);

    var platforms = [];
    for (var p = 0; p < js.length; p++) {
      if (js[p].platform && platforms.indexOf(js[p].platform) < 0) platforms.push(js[p].platform);
    }
    var onExpected = platforms.indexOf(EXPECT_PLATFORM) >= 0;
    line(onExpected ? OK : MEH, "job platform",
      (platforms.join(", ") || "not stated in the payload") +
      (onExpected ? "" : "  (AC4 asks for " + EXPECT_PLATFORM + ")"));

    // 3. THE transport rule. Derived from what was available, not from the UA:
    //    runtime present => it must carry the job (Chromium no-regression);
    //    runtime absent  => the bridge must carry it (the Firefox path).
    var expected = state.runtimeAvailable ? "externally_connectable" : "bridge";
    var used = [];
    for (var t = 0; t < js.length; t++) {
      if (used.indexOf(js[t].transport) < 0) used.push(js[t].transport);
    }
    var correct = used.length === 1 && used[0] === expected;
    var detail = "used " + used.join(" + ") + ", expected " + expected;
    if (!correct && used.length > 1) {
      detail += "  — the page sent over BOTH transports, which lists the item twice";
    } else if (!correct && expected === "externally_connectable") {
      detail += "  — REGRESSION: externally_connectable is available and was not used " +
        "(or VITE_LISTER_EXTENSION_ID is unset in this deployment)";
    } else if (!correct) {
      detail += "  — externally_connectable is absent here, so the bridge is the only path home";
    }
    line(correct ? OK : NO, "transport used", detail);

    // 4. Did the answer come back?
    var unanswered = 0, viaPush = 0;
    for (var a = 0; a < js.length; a++) {
      if (!js[a].response) unanswered++;
      else if (js[a].via === "push") viaPush++;
    }
    line(unanswered ? NO : OK, "job answered",
      unanswered ? unanswered + " of " + js.length + " job(s) never reported back — " +
        "on Firefox that is what an ungranted gradethread.com looks like: it hangs rather than fails"
        : js.length + " of " + js.length + " answered (" + viaPush + " via the durable push)");

    // 5. Correlation ids. Only the bridge carries them; the runtime port is its own
    //    channel, so there is nothing to correlate there.
    if (expected === "bridge") {
      var missingIds = 0;
      for (var c = 0; c < js.length; c++) if (!js[c].id) missingIds++;
      line(missingIds || state.strayReplies ? NO : OK, "correlation ids round-tripped",
        missingIds ? missingIds + " envelope(s) carried no id"
          : state.strayReplies ? state.strayReplies + " reply(ies) quoted an id nobody sent"
            : "every envelope carried an id and every reply matched one");
    } else {
      line(MEH, "correlation ids round-tripped", "n/a — externally_connectable uses its own port");
    }

    // 6. The outcome the seller actually got.
    var last = js[js.length - 1];
    var r = last.response || {};
    var filled = r.ok === true && r.filled === true;
    var photos = r.photosTotal == null ? "" :
      "  photos " + ((r.photosTotal || 0) - (r.photosFailed || 0)) + " of " + r.photosTotal;
    line(filled ? OK : (r.ok === true ? MEH : NO), "job result",
      (r.ok === true ? "ok" : "ok=false") +
      (r.filled === true ? ", filled" : ", NOT filled") +
      photos +
      (last.transportErrors ? "  (recovered from " + last.transportErrors +
        " transport error(s) — the worker/event page was torn down mid-job)" : "") +
      (r.needsUpgrade ? "  (seller gate: account is not on a paid FlipDesk plan)" : "") +
      (r.needsConsent ? "  (consent clickwrap not accepted yet)" : "") +
      (r.loginWall ? "  (marketplace showed a login wall — job left queued)" : "") +
      (r.error ? "  error: " + r.error : ""));

    // 7. The two LATER events. Neither is required for a pass: the fast path can
    //    answer before the worker dies, and the seller may never submit the form.
    line(state.pushes.length ? OK : MEH, "durable push relay (US-1874)",
      state.pushes.length ? state.pushes.length + " push(es) relayed by the bridge"
        : "none seen — fine if the job answered on the fast path");
    line(state.listed.length ? OK : MEH, "live listing captured (US-1877)",
      state.listed.length ? state.listed[state.listed.length - 1].listingUrl
        : "none — expected unless you submitted the form with this tab still open");

    return finish(rows, expected, used.join("+"));
  }

  function finish(rows, expected, used) {
    var fails = 0, warns = 0;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].status === NO) fails++;
      else if (rows[i].status === MEH) warns++;
    }
    var verdict = fails ? "FAIL" : (warns ? "PASS (with warnings)" : "PASS");
    var family = browserFamily();
    console.log("%cGradeThread transport check — US-1882 AC4", "font-weight:bold;font-size:13px");
    console.table(rows);
    console.log("%cVERDICT: " + verdict + "  —  " + fails + " failing, " + warns + " warning",
      "font-weight:bold;font-size:13px;color:" + (fails ? "#E94560" : "#0F3460"));
    console.log(
      "Paste this line back into the story/runbook:\n  " +
      "US-1882 AC4 | " + family + " | transport=" + (used || "none") +
      " | expected=" + (expected || "n/a") +
      " | " + new Date().toISOString().slice(0, 10) + " | " + verdict);
    return {
      verdict: verdict,
      fails: fails,
      warns: warns,
      rows: rows,
      browser: family,
      expected: expected,
      used: used,
      state: state,
    };
  }

  console.log(
    "%cGradeThread transport check armed." +
    "\n  bridge marker: " + (state.marker ? "present" : "ABSENT") +
    "\n  externally_connectable: " + (state.runtimeAvailable ? "available" : "absent") +
    "\n\nNow run the seller flow (FlipDesk -> Send to extension -> " + EXPECT_PLATFORM + ")," +
    "\nthen come back to this tab and run:  __gtTransportCheck.report()",
    "color:#0F3460");

  return { report: report, state: state };
`;

/**
 * The snippet's payload as a bare `function () {…}` expression.
 *
 * Exported as its own seam so the test can `new Function(…)` it with a stub
 * window/document and drive a whole simulated session — running the same source
 * the operator pastes rather than a re-implementation of it.
 */
export function buildTransportFunctionSource({ expectPlatform = "poshmark", bridgeSrc } = {}) {
  assertBridgeSource(bridgeSrc);
  return [
    `function () {`,
    `  var EXPECT_PLATFORM = ${JSON.stringify(expectPlatform)};`,
    `  var JOB_TYPES = ${JSON.stringify(JOB_TYPES)};`,
    SNIPPET_BODY,
    `}`,
  ].join("\n");
}

/** Build the paste-ready snippet. */
export function buildTransportSnippet(opts = {}) {
  const expectPlatform = opts.expectPlatform ?? "poshmark";
  const header = [
    `// GradeThread — web↔extension transport check (US-1882 AC4).`,
    `//`,
    `// Open gradethread.com in the browser under test, sign in, open DevTools on the`,
    `// FlipDesk tab and paste this whole script into the Console. It wraps the two`,
    `// transports and then watches: it does not send anything itself.`,
    `//`,
    `// Then run the real seller flow (Listing Kit -> Send to extension, ${expectPlatform}),`,
    `// come back to this tab and run:  __gtTransportCheck.report()`,
    `//`,
    `// Generated by: node scripts/transport-verify.mjs snippet`,
    `// Do not edit this text — regenerate it, or it stops describing the shipped protocol.`,
    ``,
  ].join("\n");

  return [
    header,
    `window.__gtTransportCheck = (${buildTransportFunctionSource({ ...opts, expectPlatform })})();`,
    ``,
  ].join("\n");
}
