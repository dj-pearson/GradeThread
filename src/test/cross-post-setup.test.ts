import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2718 / US-2719 / US-2720.
//
// On 2026-08-20 the production bundle at gradethread.com compiled
// `isListerAvailable()` down to `return !1` and `listerExtensionId()` down to
// `return ""` — VITE_LISTER_EXTENSION and VITE_LISTER_EXTENSION_ID were both
// unset on the Cloudflare Pages build. The cross-listing engine was entirely
// intact; the one control that starts it did not exist on the live site, and
// nothing anywhere said so. The Marketplaces page told sellers to "Install the
// GradeThread Lister browser extension" in a sentence that was not a link, and
// the Listing Kit answered `showSend === false` by rendering nothing at all.
//
// These guards are about the SHAPE of the fix, not about the env values, which
// live in a dashboard this repo cannot read.

const KIT = "src/components/flipdesk/listing-kit.tsx";
const EXT = "src/lib/lister-extension.ts";
const SETUP = "src/components/flipdesk/cross-post-setup.tsx";
const SETUP_HOOK = "src/hooks/use-extension-setup.ts";
const MARKETPLACES = "src/pages/flipdesk/marketplaces.tsx";
const VITE_CONFIG = "vite.config.ts";
const BACKGROUND = "extension-unified/background.js";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

/** The file with comments stripped — a guard that reads prose punishes writing it. */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the build refuses a half-configured bridge (US-2718)", () => {
  it("a production build fails when the flag is on and the id is empty", () => {
    const src = code(VITE_CONFIG);
    expect(src).toContain("listerBridgeGuardPlugin");
    expect(src).toContain("VITE_LISTER_EXTENSION_ID");
    // It must read the RESOLVED vite env, not process.env — the latter carries
    // no .env file, so the guard would pass a broken local build.
    expect(src).toContain("config.env.VITE_LISTER_EXTENSION");
    expect(src).toMatch(/this\.error\(failure\)/);
  });

  it("the guard is registered in the plugin list", () => {
    // Raw, not comment-stripped: vite.config.ts contains glob and regex
    // literals holding `*/`, which unbalances any naive block-comment stripper
    // and eats the plugin array along with them.
    expect(read(VITE_CONFIG)).toContain("listerBridgeGuardPlugin(),");
  });
});

describe("an unavailable cross-post says which of the two causes it is (US-2720)", () => {
  it("listerUnavailableReason separates 'switched off' from 'not installed'", () => {
    const src = code(EXT);
    expect(src).toContain("export function listerUnavailableReason()");
    expect(src).toContain('return "disabled"');
    expect(src).toContain('return "not-installed"');
    // The flag is checked FIRST. With the feature off, "install the extension"
    // is a false trail — nothing the seller installs will make the button appear.
    const body = src.slice(src.indexOf("export function listerUnavailableReason()"));
    expect(body.indexOf('"disabled"')).toBeLessThan(body.indexOf('"not-installed"'));
  });

  it("the Listing Kit renders a reason instead of nothing", () => {
    const src = code(KIT);
    expect(src).toContain("listerUnavailableReason()");
    expect(src).toContain("CrossPostNotice");
    // The manual fallback is not touched by any of this.
    expect(src).toContain("Copy all fields");
    expect(src).toContain("Download photos");
  });

  it("a channel whose selectors are unverified says so before the click", () => {
    const src = code(KIT);
    expect(src).toContain("MARKETPLACE_EXTENSION_FLOW");
    expect(src).toContain('=== "verifying"');
  });

  it("needsUpgrade renders a plan link, and is never inferred", () => {
    const src = code(KIT);
    expect(src).toContain("res.needsUpgrade");
    expect(src).toContain("setNeedsUpgrade(true)");
    expect(src).toContain('to="/pricing"');
  });
});

describe("an undeliverable send fails fast and honestly (US-2724)", () => {
  it("the two Chrome messaging failures are told apart", () => {
    const src = code(EXT);
    expect(src).toContain("export function isUndeliverable");
    expect(src).toContain("receiving end does not exist");
    expect(src).toContain("could not establish connection");
  });

  it("an unrecognised transport error stays in the recoverable branch", () => {
    // Wrongly settling a live job is worse than a slow failure, so the default
    // must be false — never a catch-all that swallows the US-1874 case.
    const src = code(EXT);
    const fn = src.slice(src.indexOf("export function isUndeliverable"));
    expect(fn).toContain("if (!message) return false");
  });

  it("a job send settles on undelivered and keeps waiting on a dead port", () => {
    const src = code(EXT);
    expect(src).toContain("if (r && r.undelivered)");
    // The US-1874 guarantee is untouched: a plain transportError still returns
    // without settling, so a suspended worker's job can still report via push.
    expect(src).toContain("if (r && r.transportError) return;");
    const order = src.indexOf("r.undelivered");
    expect(order).toBeLessThan(src.indexOf("if (r && r.transportError) return;"));
  });

  it("an undelivered id-addressed send retries over the bridge, which needs no id", () => {
    // Proven live 2026-08-20: the site was configured for the store id
    // apinefjjagmigmobdlbiilhbjebmjkdh while an unpacked build
    // (nfbjhdjkhpeccfmiedjhchleaeapnkki) was the one installed. The bridge
    // reaches whichever build is actually there.
    const src = code(EXT);
    const fn = src.slice(src.indexOf("export function sendExtensionMessage"));
    expect(fn).toContain("r.undelivered && bridgeAvailable() ? sendViaBridge(message) : r");
  });

  it("a port that closed mid-job is never retried", () => {
    // Something DID receive that one. A second send would open a second tab and
    // could produce a duplicate listing.
    const src = code(EXT);
    const fn = src.slice(src.indexOf("export function sendExtensionMessage"));
    const retry = fn.slice(0, fn.indexOf("} else if"));
    expect(retry).not.toContain("transportError");
  });

  it("the message does not blame the extension or name a tab that never opened", () => {
    const src = code(EXT);
    const branch = src.slice(src.indexOf("if (r && r.undelivered)"));
    const msg = branch.slice(0, branch.indexOf("return;"));
    expect(msg).not.toContain("didn't report back");
    expect(msg).not.toContain("marketplace tab");
    expect(msg).toContain("extensions page");
  });
});

describe("the web can queue a cross-post for the desktop (US-2722)", () => {
  it("the Listing Kit enqueues a LIST job, not only a delist", () => {
    const src = code(KIT);
    expect(src).toContain("useEnqueueExtensionWork");
    expect(src).toContain('kind: "list"');
  });

  it("the copy is QUEUED_NOTICE verbatim, shared with iOS, Android and the edge", () => {
    const src = code(KIT);
    expect(src).toContain("QUEUED_NOTICE");
    // Never a hand-written near-copy: a queued job described as listed is the
    // failure this whole notice exists to prevent.
    expect(src).not.toMatch(/Queued\.\s*It will list/);
  });

  it("the control only appears when this browser cannot run it", () => {
    // Inside the not-installed branch of the notice — offering it next to a
    // working Send button would be two paths to the same listing.
    const src = code(KIT);
    const notice = src.slice(src.indexOf("export function CrossPostNotice"));
    const branch = notice.slice(notice.indexOf('reason === "not-installed"'));
    expect(branch).toContain("Queue for my desktop");
  });
});

describe("a dev build can still connect its account (US-2731)", () => {
  const CONNECT = "src/pages/connect-extension.tsx";

  it("a mismatching ?ext is treated as a dev build, not only as an attack", () => {
    const src = code(CONNECT);
    expect(src).toContain("const preferBridge = Boolean(extId && extId !== configuredExtId)");
    expect(src).toContain("preferBridge }");
  });

  it("the mismatching id is never used as an address", () => {
    // targetExtId still only ever holds an id that EQUALS the configured one.
    // preferBridge is a boolean signal, not a destination.
    const src = code(CONNECT);
    expect(src).toContain(
      "extId && configuredExtId && extId === configuredExtId ? extId : undefined",
    );
  });

  it("preferBridge only ever selects our own content-script relay", () => {
    const src = code(EXT);
    const fn = src.slice(src.indexOf("export function sendExtensionMessage"));
    expect(fn).toContain("if (opts?.preferBridge && bridgeAvailable()) {");
    expect(fn).toContain("p = sendViaBridge(message);");
    // It must not fall back to an id-addressed send with the untrusted value.
    expect(fn).not.toContain("opts?.preferBridge ? opts.extensionId");
  });
});

describe("cross-posting has a setup flow with real state (US-2719)", () => {
  it("the section is on the Marketplaces page", () => {
    expect(code(MARKETPLACES)).toContain("<CrossPostSetup />");
  });

  it("the dead 'Install the ...' instruction is gone from the page prose", () => {
    // It was the only install instruction on the page and it was not a link.
    expect(read(MARKETPLACES)).not.toContain("Install the\n              GradeThread Lister");
  });

  it("'installed' comes from the DOM bridge marker, not the feature flag", () => {
    const src = code(SETUP_HOOK);
    expect(src).toContain("isExtensionInstalled()");
    expect(src).not.toContain("VITE_LISTER_EXTENSION");
  });

  it("signed-in, plan and terms all come from the extension's own answer", () => {
    const src = code(SETUP_HOOK);
    expect(src).toContain('type: "GT_PING"');
    expect(src).toContain("caps.authenticated === true");
    expect(src).toContain("caps.sellerEnabled === true");
    expect(src).toContain("res.tosAccepted === true");
  });

  it("an extension too old to report acceptance reads as not-yet, never as done", () => {
    // `=== true` rather than a truthy check or a default, so an absent field
    // cannot render a green step over a gate that will refuse the first send.
    expect(code(SETUP_HOOK)).toContain("tosAccepted: res.tosAccepted === true");
  });

  it("the install CTA uses the store URL and never falls back to a settings page", () => {
    const src = code(SETUP);
    expect(src).toContain("extensionWebStoreUrl()");
    expect(src).not.toContain("/buyer/settings");
  });

  it("the terms step offers no accept button, because the web may not grant it", () => {
    const src = code(SETUP);
    const terms = src.slice(src.indexOf('key: "terms"'), src.indexOf('key: "channel"'));
    expect(terms).not.toContain("action:");
    expect(terms).toContain("in the extension");
  });

  it("a deployment with the feature off does not hand the seller an install trail", () => {
    const src = code(SETUP);
    expect(src).toContain('state.unavailable === "disabled"');
  });
});

describe("GT_PING carries what the setup screen needs (US-2719)", () => {
  it("the ping reports acceptance and per-channel readiness", () => {
    const src = read(BACKGROUND);
    const ping = src.slice(src.indexOf('msg.type === "GT_PING"'));
    expect(ping).toContain("tosAccepted: await tosAccepted()");
    expect(ping).toContain("canList:");
    expect(ping).toContain("canDelist:");
  });

  it("there is still no way for a page to ACCEPT the terms", () => {
    // Reporting the flag is not granting it. The clickwrap must render from the
    // extension's own copy, so no accept type may be reachable externally.
    const src = read(BACKGROUND);
    const set = src.slice(src.indexOf("const EXTERNAL_TYPES"), src.indexOf("function handleExternalMessage"));
    expect(set).not.toContain('"GT_TOS_ACCEPT"');
    expect(set).not.toContain('"GT_POLL_ACCEPT"');
  });
});
