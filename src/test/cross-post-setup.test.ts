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
    // The positive half — that it names an action the reader can take — is
    // asserted in the US-2733 block, which owns the current wording. Pinning
    // the exact phrase in two places is how a copy fix fails an unrelated test,
    // which is what happened here.
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

describe("an orphaned bridge fails fast instead of hanging (US-2733)", () => {
  const BRIDGE = "extension-unified/gt-bridge.js";

  it("an invalidated extension context counts as non-delivery", () => {
    // Reloading an unpacked extension orphans the content scripts in open tabs.
    // The DOM marker survives, so the page still believes the relay is alive.
    expect(code(EXT)).toContain("extension context invalidated");
  });

  it("the bridge reports it on every path it can fail on", () => {
    const src = read(BRIDGE);
    // Chromium callback, promise rejection, and the synchronous throw.
    expect(src.match(/undelivered: isDead\(/g)?.length).toBe(3);
  });

  it("the message tells the user to reload the page", () => {
    const src = code(EXT);
    const branch = src.slice(src.indexOf("if (r && r.undelivered)"));
    expect(branch.slice(0, branch.indexOf("return;"))).toContain("Reload this page");
  });
});

describe("a draft with no stored price still cross-posts one (US-2736)", () => {
  it("the kit resolves a price at render, not only at generation", () => {
    // A variant's price is written once, when it is generated. Every draft made
    // before the generator fix carries 0, and fixing only the generator would
    // leave them all broken until someone thought to press Regenerate.
    const src = code(KIT);
    expect(src).toContain("const fallbackPrice =");
    // All THREE sources the composer reads. Checking only two is what left an
    // item priced through list_price showing a blank price after the fix that
    // was meant to end exactly that.
    // NOT list_price on inventory_items — that column is on the items_full
    // VIEW, and asking this table for it fails the whole query.
    expect(src).toContain('.select("target_price")');
    expect(src).not.toContain('"target_price, list_price"');
    expect(src).toContain("data?.listing_price");
    expect(src).toContain("itemPrice?.target_price");
    expect(src).toContain("itemPrice?.any_listing_price");
  });

  it("first POSITIVE price wins, not first non-null", () => {
    // A stale 0 on a draft row must not shadow a real price further down.
    const src = code(KIT);
    // The null check moved into numericOr (US-2740), which returns 0 for
    // null/undefined/junk — so the list is coerced first and then filtered on
    // "> 0" alone. Same rule, one place.
    expect(src).toContain(".map((p) => numericOr(p, 0)).find((p) => p > 0)");
    const first = (a: (number | null)[]) => a.find((p) => p != null && p > 0) ?? 0;
    expect(first([32.49, 19, 5])).toBe(32.49);
    expect(first([0, null, 24.99])).toBe(24.99);
    expect(first([null, null, 32.49])).toBe(32.49);
    expect(first([null, 0, null])).toBe(0);
  });

  it("display, validation and payload all read the SAME resolved variant", () => {
    // Patching only the render would show a price the extension still refuses
    // to type, which is the failure this whole thread has been about.
    const src = code(KIT);
    expect(src).toContain("const priced: PlatformKitVariant =");
    expect(src).toContain("fieldValue(f.key, priced)");
    expect(src).toContain("variant: priced,");
  });

  it("it never invents a price", () => {
    // No price anywhere means the variant is left exactly as stored rather than
    // being given a number nobody chose. Two guards carry that now: the step
    // maths only runs on a price above zero, and an unchanged value returns the
    // original object rather than a copy.
    const src = code(KIT);
    expect(src).toContain("const resolvedPrice = variant.price > 0 ? variant.price : fallbackPrice");
    // The step maths moved into the exported stepPrice (US-2739), where its
    // "never invents a price" behaviour is asserted by CALLING it rather than by
    // matching the expression: src/test/step-price.test.ts, "never goes below
    // one step, and never invents a price".
    expect(src).toContain("const steppedPrice = stepPrice(");
    expect(src).toContain("steppedPrice === variant.price");
  });
});

describe("a price is sent in the units the marketplace accepts (US-2739)", () => {
  it("Poshmark is declared as whole dollars", () => {
    // Its listing-price input is inputmode="numeric" pattern="[0-9]*" -- digits
    // only, no decimal point -- because Poshmark prices in whole dollars.
    // Confirmed by the founder against the live form 2026-08-20.
    const src = code("src/lib/marketplace-specs.ts");
    expect(src).toContain("priceStep?: number;");
    expect(src).toContain("priceStep: 1,");
  });

  it("the step is applied where display and payload already agree", () => {
    // Rounding only in the payload would show the seller one number and send
    // another, which is the class of bug this whole file guards against. This is
    // a placement check: ONE steppedPrice, computed before the row, the
    // validation and the payload all read it.
    const src = code(KIT);
    expect(src).toContain("const resolvedPrice = variant.price > 0 ? v");
    expect(src).toContain("const steppedPrice = stepPrice(");
    expect(src).toContain("steppedPrice === variant.price");
  });

  // THE ROUNDING RULE ITSELF IS TESTED IN src/test/step-price.test.ts, against
  // the exported stepPrice.
  //
  // It used to be tested here, and it was not really tested at all: the case
  // list re-implemented the expression inside the test and asserted against that
  // copy. Changing listing-kit.tsx to FLOOR instead of round - the one thing AC4
  // exists to prevent, because it quietly costs the seller money on every
  // cross-post - left all six "pinned" cases green. Verified by sabotage, with a
  // control run to be sure the failure was the sabotage and not the refactor.
});

describe("a numeric string is a price, not a zero (US-2740)", () => {
  it("the variant parser coerces instead of type-checking", () => {
    // The item that exposed this had platform_fields->poshmark->price sitting
    // at 32.49 while every surface showed nothing, because the parser asked
    // `typeof raw.price === "number"` and a numeric string is not.
    const src = code(KIT);
    expect(src).toContain("function numericOr(");
    expect(src).toContain("price: numericOr(raw.price, 0)");
    expect(src).not.toContain('typeof raw.price === "number"');
  });

  it("the fallback coerces too", () => {
    // PostgREST returns a Postgres `numeric` as a STRING. "32.49" > 0 is true
    // by coercion while typeof === "number" is false, so a real price behaved
    // like a present value in one comparison and an absent one in the next.
    const src = code(KIT);
    expect(src).toContain("numericOr(p, 0)");
  });

  it("junk never becomes a price", () => {
    const numericOr = (value: unknown, fallback: number): number => {
      if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
      if (typeof value === "string" && value.trim() !== "") {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
      }
      return fallback;
    };
    expect(numericOr(32.49, 0)).toBe(32.49);
    expect(numericOr("32.49", 0)).toBe(32.49);
    // A price is money; coercing junk would put it on a live listing.
    expect(numericOr("TBD", 0)).toBe(0);
    expect(numericOr("", 0)).toBe(0);
    expect(numericOr(null, 0)).toBe(0);
    expect(numericOr(Number.NaN, 0)).toBe(0);
    expect(numericOr({}, 0)).toBe(0);
  });
});

describe("a price dialog is the price, not a fallback (US-2741)", () => {
  const COMMON = "extension-unified/lister/common.js";

  it("the form field is skipped when a dialog is declared", () => {
    // On Poshmark the create-form input is a button that looks like a field.
    // Setting it DOES take -- vee-validate flashes an estimated earnings figure
    // ($25.60 on a $32 listing, its 20% fee) -- and then reverts, because the
    // authoritative value lives in the dialog. So filling it looks like success
    // and leaves the listing priced at nothing.
    const src = read(COMMON);
    expect(src).toContain("const usesPriceDialog = Boolean(flow.priceDialog");
    expect(src).toContain("const priceFilled = !usesPriceDialog && f.price");
  });

  it("the dialog runs whether or not the field fill would have worked", () => {
    // It was gated on !priceFilled, so a form fill that "succeeded" skipped the
    // dialog entirely -- which is exactly how the price went missing.
    const src = read(COMMON);
    expect(src).toContain("if (usesPriceDialog && payload.price) {");

    // NOT pinned to one spelling of the gate. This asserted only
    //   not.toContain("flow.priceDialog && !priceFilled")
    // and re-introducing the identical bug as a plain `if (!priceFilled)` on the
    // line above the call sailed straight through it -- verified by sabotage.
    // A guard that names one phrasing of a mistake defends against that
    // phrasing, not against the mistake.
    //
    // So: look at what actually precedes the call, and match the VARIABLE
    // rather than an operator. A first attempt matched /!\s*priceFilled/ and
    // `if (priceFilled === false)` walked straight past it - the same mistake
    // one negation away. priceFilled does not match `dialogPriceFilled`,
    // which is the legitimate assignment on the call line.
    const body = src.slice(src.indexOf("GT.runFlow"), src.indexOf("GT.runDelistFlow"));
    const call = body.indexOf("GT.fillPriceDialog(");
    expect(call, "the price dialog is no longer called from runFlow").toBeGreaterThan(-1);
    const preceding = body.slice(Math.max(0, call - 200), call);
    expect(
      preceding,
      "the price-dialog call is gated on priceFilled again. A form fill that " +
        "'succeeds' against Poshmark's display field would skip the dialog, " +
        "which is how the listing ended up priced at nothing (US-2741).",
    ).not.toMatch(/(^|[^a-zA-Z])priceFilled([^a-zA-Z]|$)/);
  });

  it("the dialog runs BEFORE the photos", () => {
    // It ran after, on the reasoning that an open modal covers the file input.
    // attachPhotos never clicks: it resolves the input and assigns .files, and
    // an overlay blocks pointer events, not property assignment. The real
    // hazard ran the other way -- Poshmark opens its own confirmation modal
    // once photos attach, and that backdrop swallows the click that opens the
    // price dialog. Reported live: photos confirmed, price blank, no flash.
    const src = read(COMMON);
    const body = src.slice(src.indexOf("GT.runFlow"), src.indexOf("GT.runDelistFlow"));
    expect(body.indexOf("GT.fillPriceDialog")).toBeLessThan(
      body.indexOf("GT.attachPhotos"),
    );
  });

  it("attachPhotos still never clicks, which is what makes that order safe", () => {
    const src = read(COMMON);
    const from = src.indexOf("GT.attachPhotos = ");
    // To the NEXT definition, not to some later landmark: commitTags and
    // fillPriceDialog both sit between attachPhotos and GT.result, and both
    // click on purpose, so a loose boundary fails on their code.
    const to = src.indexOf("GT.commitTags = ", from);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    expect(src.slice(from, to)).not.toContain(".click()");
  });

  it("a failed dialog fill is still reported loudly", () => {
    // Same treatment the form-field miss has had since US-2477: a price we
    // could not set is the one thing the seller must not find out after
    // publishing.
    const src = read(COMMON);
    expect(src).toContain("usesPriceDialog && !dialogPriceFilled");
    expect(src).toContain("could NOT set the price");
  });
});

describe("each tab names what the seller still has to set (US-2745)", () => {
  const SPECS = "src/lib/marketplace-specs.ts";

  it("only VERIFIED platforms declare manual fields", () => {
    // An unset value means "not established", never "the extension fills
    // everything". Poshmark and Mercari were confirmed on the live form;
    // Grailed and Vinted were not, so they must stay silent rather than make a
    // promise nobody checked.
    const src = code(SPECS);
    const declared = [...src.matchAll(/manualFields: \[/g)].length;
    expect(declared).toBe(2);
  });

  it("the labels come from the spec's own fields, so they cannot drift", () => {
    const src = code(KIT);
    expect(src).toContain("spec.fields.find((f) => f.key === key)?.label");
  });

  it("a platform with none renders nothing at all", () => {
    const src = code(KIT);
    expect(src).toContain("manualFieldLabels.length > 0 &&");
  });

  it("every declared key exists on that platform's field list", () => {
    // A key with no matching field would silently vanish from the notice.
    const src = code(SPECS);
    for (const platform of ["poshmark", "mercari"]) {
      const start = src.indexOf(`  ${platform}: {`);
      const block = src.slice(start, src.indexOf("sourceNote", start));
      const declared = /manualFields: \[([^\]]*)\]/.exec(block);
      expect(declared, `${platform} should declare manualFields`).toBeTruthy();
      const keys = (declared?.[1] ?? "")
        .split(",")
        .map((k) => k.trim().replace(/"/g, ""))
        .filter(Boolean);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(block, `${platform}.${key} must be a real field`).toContain(
          `key: "${key}"`,
        );
      }
    }
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
