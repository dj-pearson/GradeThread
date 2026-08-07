// US-1882 — tests for the transport verification mechanism
// (scripts/transport-verify.mjs).
//
// This is generated text a human pastes into a browser console, so nothing else
// in the build can tell whether it runs. A verification tool that silently
// reports PASS is worse than no tool — so these tests EXECUTE the generated
// source against stub windows and drive whole simulated sessions through it:
// a healthy Firefox bridge run, a healthy Chromium externally_connectable run,
// and the failures each browser is actually exposed to.
//
// The verdicts are mutation-checked: the Chromium regression case is the same
// session as the Chromium pass case with only the transport swapped.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildTransportFunctionSource,
  buildTransportSnippet,
  BRIDGE_TOKENS,
} from "./lib/transport-verification.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgeSrc = fs.readFileSync(
  path.join(root, "extension-unified", "gt-bridge.js"),
  "utf8",
);

const FIREFOX_UA =
  "Mozilla/5.0 (Windows NT 10.0; rv:141.0) Gecko/20100101 Firefox/141.0";
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Safari/537.36";

/**
 * A stub window with real same-window postMessage semantics: a post is delivered
 * to the registered listeners with `source` set to the window, which is what every
 * real browser does (and what jsdom notably does not).
 */
function makeWindow({ ua, marker = true, chrome = null, framed = false } = {}) {
  const listeners = [];
  const win = {
    navigator: { userAgent: ua },
    document: {
      documentElement: {
        getAttribute: (name) =>
          name === "data-gt-ext-bridge" && marker ? "1" : null,
      },
    },
    chrome,
    addEventListener(type, fn) {
      if (type === "message") listeners.push(fn);
    },
    postMessage(data) {
      for (const fn of listeners.slice()) {
        fn({ source: win, origin: "https://gradethread.com", data });
      }
    },
  };
  win.top = framed ? { other: true } : win;
  return win;
}

/** Chromium's page-side externally_connectable shim. */
function makeChrome() {
  const chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(_id, _message, cb) {
        if (typeof cb === "function") cb(chrome.runtime.__response);
      },
      __response: undefined,
    },
  };
  return chrome;
}

function install(win) {
  const source = buildTransportFunctionSource({ bridgeSrc });
  const quietConsole = { log() {}, table() {} };
  const factory = new Function("window", "console", `return (${source});`);
  return factory(win, quietConsole)();
}

function row(result, check) {
  const found = result.rows.find((r) => r.check === check);
  if (!found) throw new Error(`no "${check}" row in: ${result.rows.map((r) => r.check).join(", ")}`);
  return found;
}

// ── the page's own behaviour, reproduced ──────────────────────────────────────
// These stand in for src/lib/lister-extension.ts. The tool never calls them; it
// only watches, which is the whole point of its design.

let idSeq = 0;
function appSendViaBridge(win, message) {
  const id = `gt-${++idSeq}`;
  win.postMessage({ __gtExtReq: true, id, message }, "https://gradethread.com");
  return id;
}

function bridgeReply(win, id, response) {
  win.postMessage({ __gtExtRes: true, id, response }, "https://gradethread.com");
}

function backgroundPush(win, payload) {
  win.postMessage({ __gtExtPush: true, ...payload }, "https://gradethread.com");
}

function appSendViaRuntime(win, message, response, lastError) {
  win.chrome.runtime.lastError = lastError;
  win.chrome.runtime.sendMessage("ext-id", message, (r) => r);
  // the stub calls back synchronously with whatever is parked on __response
  win.chrome.runtime.lastError = undefined;
  void response;
}

function runtimeJob(win, message, response, lastError) {
  win.chrome.runtime.__response = response;
  appSendViaRuntime(win, message, response, lastError);
}

const LIST_JOB = (clientRef = "ref-1", platform = "poshmark") => ({
  type: "GT_LISTER_LIST",
  clientRef,
  payload: { platform, title: "Vintage Levis Denim Jacket" },
});

const FILLED = { ok: true, filled: true, photosTotal: 8, photosFailed: 0 };

describe("the Firefox bridge session", () => {
  it("passes a healthy end-to-end Poshmark run", () => {
    const win = makeWindow({ ua: FIREFOX_UA });
    const check = install(win);

    const id = appSendViaBridge(win, LIST_JOB());
    bridgeReply(win, id, FILLED);
    backgroundPush(win, {
      type: "GT_LISTER_LISTED",
      platform: "poshmark",
      itemId: "item-1",
      listingUrl: "https://poshmark.com/listing/abc123",
    });

    const result = check.report();
    expect(result.verdict).toBe("PASS");
    expect(result.fails).toBe(0);
    expect(result.expected).toBe("bridge");
    expect(result.used).toBe("bridge");
    expect(result.browser).toBe("firefox");
    expect(row(result, "job result").detail).toMatch(/ok, filled {2}photos 8 of 8/);
    expect(row(result, "live listing captured (US-1877)").detail).toContain("poshmark.com/listing/abc123");
  });

  it("keeps the page's own postMessage working (it observes, it does not intercept)", () => {
    const win = makeWindow({ ua: FIREFOX_UA });
    const check = install(win);
    const seen = [];
    win.addEventListener("message", (e) => seen.push(e.data));

    const id = appSendViaBridge(win, LIST_JOB());
    bridgeReply(win, id, FILLED);

    // Both the request and the reply still reached the page's listeners.
    expect(seen.filter((d) => d.__gtExtReq)).toHaveLength(1);
    expect(seen.filter((d) => d.__gtExtRes)).toHaveLength(1);
    expect(check.report().fails).toBe(0);
  });

  it("fails when the job never reports back (an ungranted gradethread.com HANGS)", () => {
    const win = makeWindow({ ua: FIREFOX_UA });
    const check = install(win);
    appSendViaBridge(win, LIST_JOB());

    const result = check.report();
    expect(result.verdict).toBe("FAIL");
    expect(row(result, "job answered").status).toBe("FAIL");
    expect(row(result, "job answered").detail).toMatch(/hangs rather than fails/);
  });

  it("accepts the durable push as the answer when the port died mid-job", () => {
    const win = makeWindow({ ua: FIREFOX_UA });
    const check = install(win);

    const id = appSendViaBridge(win, LIST_JOB("ref-9"));
    bridgeReply(win, id, { ok: false, transportError: true, error: "Extension error." });
    backgroundPush(win, {
      type: "GT_LISTER_JOB_UPDATE",
      clientRef: "ref-9",
      result: { ok: true, filled: true },
    });

    const result = check.report();
    // The tool applies the page's own rule: a transportError does not settle a
    // job, so the push replaces it and the run reads as the success the seller
    // actually got — while still saying the port died on the way.
    expect(result.fails).toBe(0);
    expect(row(result, "durable push relay (US-1874)").status).toBe("PASS");
    expect(row(result, "job answered").detail).toMatch(/1 via the durable push/);
    expect(row(result, "job result").status).toBe("PASS");
    expect(row(result, "job result").detail).toMatch(/recovered from 1 transport error/);
  });

  it("does not let a second reply overwrite a real answer", () => {
    const win = makeWindow({ ua: FIREFOX_UA });
    const check = install(win);
    const id = appSendViaBridge(win, LIST_JOB("ref-7"));
    bridgeReply(win, id, FILLED);
    backgroundPush(win, {
      type: "GT_LISTER_JOB_UPDATE",
      clientRef: "ref-7",
      result: { ok: false, error: "a late duplicate" },
    });

    const result = check.report();
    expect(row(result, "job result").status).toBe("PASS");
    expect(result.state.requests[0].via).toBe("reply");
  });

  it("flags a reply quoting an id nobody sent", () => {
    const win = makeWindow({ ua: FIREFOX_UA });
    const check = install(win);
    const id = appSendViaBridge(win, LIST_JOB());
    bridgeReply(win, "gt-somebody-elses", FILLED);
    bridgeReply(win, id, FILLED);

    const result = check.report();
    expect(row(result, "correlation ids round-tripped").status).toBe("FAIL");
    expect(row(result, "correlation ids round-tripped").detail).toMatch(/quoted an id nobody sent/);
  });

  it("reports the seller gate as a failed job rather than a transport problem", () => {
    const win = makeWindow({ ua: FIREFOX_UA });
    const check = install(win);
    const id = appSendViaBridge(win, LIST_JOB());
    bridgeReply(win, id, {
      ok: false,
      needsUpgrade: true,
      error: "Cross-listing is a FlipDesk seller feature.",
    });

    const result = check.report();
    expect(row(result, "transport used").status).toBe("PASS");
    expect(row(result, "job result").status).toBe("FAIL");
    expect(row(result, "job result").detail).toMatch(/seller gate/);
  });

  it("warns when the job was not the platform AC4 names", () => {
    const win = makeWindow({ ua: FIREFOX_UA });
    const check = install(win);
    const id = appSendViaBridge(win, LIST_JOB("ref-1", "mercari"));
    bridgeReply(win, id, FILLED);

    const result = check.report();
    expect(row(result, "job platform").status).toBe("WARN");
    expect(row(result, "job platform").detail).toMatch(/AC4 asks for poshmark/);
  });
});

describe("the Chromium externally_connectable session", () => {
  it("passes a healthy run and expects the runtime transport", () => {
    const win = makeWindow({ ua: CHROME_UA, chrome: makeChrome() });
    const check = install(win);

    runtimeJob(win, LIST_JOB(), FILLED);

    const result = check.report();
    expect(result.fails).toBe(0);
    expect(result.expected).toBe("externally_connectable");
    expect(result.used).toBe("externally_connectable");
    expect(row(result, "correlation ids round-tripped").status).toBe("WARN");
    expect(row(result, "job result").status).toBe("PASS");
  });

  // The AC4 regression, as a one-line mutation of the passing case above.
  it("FAILS when the page falls back to the bridge with externally_connectable available", () => {
    const win = makeWindow({ ua: CHROME_UA, chrome: makeChrome() });
    const check = install(win);

    const id = appSendViaBridge(win, LIST_JOB());
    bridgeReply(win, id, FILLED);

    const result = check.report();
    expect(result.verdict).toBe("FAIL");
    expect(row(result, "transport used").status).toBe("FAIL");
    expect(row(result, "transport used").detail).toMatch(/REGRESSION/);
  });

  it("FAILS when the page sends over BOTH transports (a double listing)", () => {
    const win = makeWindow({ ua: CHROME_UA, chrome: makeChrome() });
    const check = install(win);

    runtimeJob(win, LIST_JOB(), FILLED);
    const id = appSendViaBridge(win, LIST_JOB("ref-2"));
    bridgeReply(win, id, FILLED);

    const result = check.report();
    expect(row(result, "transport used").status).toBe("FAIL");
    expect(row(result, "transport used").detail).toMatch(/lists the item twice/);
  });

  it("reports a port-closed callback as the transport error it is", () => {
    const win = makeWindow({ ua: CHROME_UA, chrome: makeChrome() });
    const check = install(win);
    win.chrome.runtime.__response = undefined;
    win.chrome.runtime.lastError = { message: "The message port closed before a response was received." };
    win.chrome.runtime.sendMessage("ext-id", LIST_JOB(), () => {});

    const result = check.report();
    expect(row(result, "job result").detail).toMatch(/port closed/);
  });
});

describe("the environment checks", () => {
  it("fails when the bridge content script is not in the page", () => {
    const win = makeWindow({ ua: FIREFOX_UA, marker: false });
    const check = install(win);
    const result = check.report();
    expect(row(result, "bridge content script installed").status).toBe("FAIL");
    expect(row(result, "bridge content script installed").detail).toMatch(/US-1881/);
  });

  it("fails, and says why, when run inside a frame", () => {
    const win = makeWindow({ ua: FIREFOX_UA, marker: false, framed: true });
    const check = install(win);
    const result = check.report();
    expect(row(result, "top-level frame").detail).toMatch(/refuses to install in a frame/);
  });

  it("says 'none yet' rather than passing when no seller job has run", () => {
    const win = makeWindow({ ua: FIREFOX_UA });
    const check = install(win);
    const result = check.report();
    expect(result.verdict).toBe("FAIL");
    expect(row(result, "seller job observed").detail).toMatch(/none yet/);
    // …and it stops there rather than inventing verdicts about a job that never ran.
    expect(result.rows.some((r) => r.check === "transport used")).toBe(false);
  });

  it("ignores non-job traffic when deciding whether a seller flow happened", () => {
    const win = makeWindow({ ua: FIREFOX_UA });
    const check = install(win);
    const id = appSendViaBridge(win, { type: "GT_GET_CAPABILITIES" });
    bridgeReply(win, id, { ok: true, capabilities: {} });
    const result = check.report();
    expect(row(result, "seller job observed").status).toBe("FAIL");
    expect(result.state.requests).toHaveLength(1);
  });

  it("identifies the browser family for the record line", () => {
    const edge = makeWindow({
      ua: "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/139.0 Safari/537.36 Edg/139.0",
      chrome: makeChrome(),
    });
    expect(install(edge).report().browser).toBe("edge");
    expect(install(makeWindow({ ua: FIREFOX_UA })).report().browser).toBe("firefox");
    expect(install(makeWindow({ ua: CHROME_UA, chrome: makeChrome() })).report().browser).toBe("chromium");
  });
});

describe("the pasted artifact", () => {
  it("is a self-contained script that installs a handle and sends nothing", () => {
    const snippet = buildTransportSnippet({ bridgeSrc });
    expect(snippet).toContain("window.__gtTransportCheck = (function () {");
    expect(snippet.trimEnd().endsWith("})();")).toBe(true);
    expect(snippet).toContain("__gtTransportCheck.report()");
    // No import/require — it has to run in a bare DevTools console.
    expect(snippet).not.toMatch(/^\s*(import|require)\s/m);
  });

  it("takes the platform it should be run against", () => {
    const snippet = buildTransportSnippet({ bridgeSrc, expectPlatform: "mercari" });
    expect(snippet).toContain(`var EXPECT_PLATFORM = "mercari";`);
    expect(snippet).toContain("Send to extension, mercari");
  });

  // The anti-drift guard: this tool measures a protocol defined in gt-bridge.js,
  // so a rename there must break the BUILD of the tool rather than produce a
  // snippet that politely observes a protocol nobody speaks any more.
  it("refuses to build when gt-bridge.js no longer declares the protocol", () => {
    for (const token of BRIDGE_TOKENS) {
      const mutated = bridgeSrc.split(token).join("__renamed__");
      expect(() => buildTransportSnippet({ bridgeSrc: mutated })).toThrow(
        /no longer declares/,
      );
    }
    expect(() => buildTransportSnippet({ bridgeSrc: "" })).toThrow(/real extension-unified/);
  });

  it("is built from the shipped bridge source, and that source still declares every token", () => {
    for (const token of BRIDGE_TOKENS) expect(bridgeSrc).toContain(token);
  });
});
