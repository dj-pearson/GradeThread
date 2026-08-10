// GradeThread unified extension — one-click selector check (US-2484).
//
// WHAT THIS GUARDS. The probe's whole job is to be pasted. A seller opens their
// sell form, clicks Check, and sends the report to us so a channel can be
// enabled. That makes the report a piece of OUTBOUND data written by a tool
// running on a page full of the seller's own listing, and the interesting
// failure is not "the report is wrong" — it is "the report quietly contains the
// page".
//
// So the first block below is a privacy test, not a correctness one: the report
// must carry selector keys, verdicts and versions, and must NOT carry page
// content or a full URL. A listing URL alone leaks an item id and, on several
// marketplaces, the seller's handle.
//
// The rest holds the scoring rule, which has one subtlety worth a test: a
// control that only exists after a click is EXPECTED to be missing on a page
// where nothing has been clicked, and counting it as a failure would make every
// clean report look broken — which is how a checking tool gets ignored.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");

function load(rel, globalName) {
  const src = fs.readFileSync(path.join(dir, rel), "utf8");
  const scope = {};
  // eslint-disable-next-line no-new-func
  return new Function("self", `${src}; return self.${globalName};`)(scope);
}

const P = load("lister/selector-probe.js", "GT_SELECTOR_PROBE");
const SELECTORS = load("lister/selectors.js", "GT_LISTER_SELECTORS");

// A page where everything our config asks for happens to exist.
const matchAll = () => true;
const matchNone = () => false;

// ── 1. The report never carries the page ───────────────────────────────────
{
  const SECRETS = [
    "Vintage Nike windbreaker size L", // a listing title
    "hunter2",
    "seller-handle-42",
    "https://www.mercari.com/us/item/m99887766/", // a full listing URL
  ];

  const report = P.buildProbeReport(SELECTORS, "mercari", matchAll, {
    host: "www.mercari.com",
    at: "2026-08-10",
  });
  const text = P.formatProbeReport(report);
  const blob = text + JSON.stringify(report);

  for (const secret of SECRETS) {
    assert.ok(
      !blob.includes(secret),
      `the probe report contains "${secret}". It is written to be pasted into a ` +
        "chat, so it must carry selector keys and verdicts only — never page " +
        "content, and never a full URL (a listing URL leaks an item id and often " +
        "the seller's handle).",
    );
  }

  // The HOST is deliberately present — it is how we know which locale was
  // checked, and it identifies nothing about the seller.
  assert.ok(text.includes("www.mercari.com"), "the host should be reported");

  // And nothing that looks like a full URL to the page under test.
  assert.ok(
    !/https:\/\/(www\.)?mercari\.com\/\S/.test(text.replace(/https:\/\/[^\s]*mercari\\?\./g, "")),
    "the report must not contain a navigable URL for the page being checked",
  );
}

// ── 2. A post-interaction control missing is NOT a failure ─────────────────
{
  // On a listing page with nothing clicked, `remove` and `confirm` do not
  // exist — they live inside an overflow menu. Counting them as failures would
  // make every honest check look broken, and a checking tool that cries wolf
  // is a checking tool nobody runs.
  const found = (sel) => !/data-test="delete-listing"|delete_listing|confirm-delete|href\*="delete"/.test(sel);
  const flow = P.probeFlow(SELECTORS.poshmark.delist, "delist", found);

  assert.ok(flow.ok, "a missing post-interaction control must not block the flow");
  assert.deepStrictEqual(flow.missingRequired, []);
  assert.ok(
    flow.entries.some((e) => e.key === "remove" && e.postInteraction),
    "`remove` must be marked as appearing only after a click",
  );
  assert.ok(
    !flow.missingOptional.includes("remove"),
    "a post-interaction control must not be counted as a plain miss either",
  );
}

// ── 3. A missing REQUIRED selector blocks, and is named ────────────────────
{
  const flow = P.probeFlow(SELECTORS.mercari, "list", matchNone);
  assert.strictEqual(flow.ok, false);
  for (const key of SELECTORS.mercari.required) {
    assert.ok(
      flow.missingRequired.includes(key),
      `${key} is required and missing but was not reported as blocking`,
    );
  }
  const text = P.formatProbeReport({ platform: "mercari", flows: [flow] });
  assert.ok(/BLOCKED, missing required:/.test(text), "the verdict line must name the blocker");
  // The selector string is printed for a MISS so the person can see what we
  // looked for — that is the actionable half of the report.
  assert.ok(text.includes(SELECTORS.mercari.fields.title), "a miss must print the selector tried");
}

// ── 4. Every shipped platform can be probed ────────────────────────────────
{
  for (const platform of ["poshmark", "mercari", "grailed", "vinted", "facebook"]) {
    const report = P.buildProbeReport(SELECTORS, platform, matchAll, { host: "x.test" });
    assert.ok(!report.error, `${platform}: ${report.error}`);
    assert.ok(report.flows.length >= 2, `${platform} should probe list + delist at minimum`);
    assert.ok(
      P.reportIsClean(report),
      `${platform} should read clean when every selector matches — if it does ` +
        "not, the flow flattening in selectorsFor has missed a key",
    );
    const flows = report.flows.map((f) => f.flow);
    assert.ok(flows.includes("list") && flows.includes("delist"), `${platform}: ${flows}`);
  }
  // Poshmark is the only one with an engagement flow today (US-2482).
  const posh = P.buildProbeReport(SELECTORS, "poshmark", matchAll, { host: "x.test" });
  assert.ok(posh.flows.map((f) => f.flow).includes("engage"));
}

// ── 5. An unknown platform reports, rather than throwing ───────────────────
{
  const report = P.buildProbeReport(SELECTORS, "etsy", matchAll, { host: "etsy.com" });
  assert.ok(report.error, "an unbundled platform must produce a reportable error");
  assert.ok(!P.reportIsClean(report));
  assert.ok(P.formatProbeReport(report).includes("ERROR:"));
}

// ── 6. A malformed selector is reported, not thrown ────────────────────────
{
  // querySelector throws on invalid syntax. A typo in our own config is exactly
  // what this tool should surface, so the throw has to become a line in the
  // report rather than an exception that kills the whole check.
  const throwing = () => { throw new Error("SyntaxError"); };
  const flow = P.probeFlow(SELECTORS.grailed, "list", throwing);
  assert.strictEqual(flow.ok, false);
  assert.ok(flow.entries.every((e) => e.invalid === true && e.found === false));
  assert.ok(P.formatProbeReport({ platform: "grailed", flows: [flow] })
    .includes("INVALID SELECTOR"));
}

// ── 7. The report states the version being tested ──────────────────────────
{
  // Without this, a report pasted a week later cannot be matched to the config
  // it was run against — and "the selectors are fine" against v2026.06.0-draft
  // says nothing about the build the seller is now running.
  const report = P.buildProbeReport(SELECTORS, "vinted", matchAll, { host: "vinted.fr" });
  const text = P.formatProbeReport(report);
  assert.ok(text.includes(SELECTORS.vinted.version), "the list flow's version must appear");
  assert.ok(/lastVerified=/.test(text), "the report must state when it was last verified");
  assert.ok(/enabled=(true|false)/.test(text), "the report must state whether the flow is on");
}

// ── 8. The pure module stays pure ──────────────────────────────────────────
{
  const raw = fs.readFileSync(path.join(dir, "lister/selector-probe.js"), "utf8");
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const forbidden of ["document.", "chrome.", "browser.", "fetch(", "location."]) {
    assert.ok(
      !code.includes(forbidden),
      `selector-probe.js uses ${forbidden}. The matcher is INJECTED so this file ` +
        "stays testable without a browser — the DOM belongs in common.js.",
    );
  }
}

// ── 9. The popup actually SHOWS it ────────────────────────────────────────
//
// THE BUG THIS CAUGHT. The block first shipped nested inside #sellerSection,
// and renderProbe() was only called from the caps.sellerEnabled branch. So the
// one tool for diagnosing a broken extension was invisible to anyone without a
// resolved paid FlipDesk plan — and, worse, invisible whenever the entitlements
// fetch failed, since that path fail-safes to anonymous and hides the whole
// seller section. It was reported as "the selectors action does not show".
//
// It is a diagnostic over our own bundled config. It grants nothing and reveals
// no seller data, so there was never anything for a plan gate to protect.
{
  const html = fs.readFileSync(path.join(dir, "popup.html"), "utf8");
  const js = fs.readFileSync(path.join(dir, "popup.js"), "utf8");

  const sellerStart = html.indexOf('id="sellerSection"');
  const sellerEnd = html.indexOf("</section>", sellerStart);
  const probeAt = html.indexOf('id="probeBlock"');

  assert.ok(probeAt !== -1, "popup.html must contain the probe block");
  assert.ok(
    !(sellerStart < probeAt && probeAt < sellerEnd),
    "#probeBlock is nested inside #sellerSection, which is hidden without an " +
      "active paid FlipDesk plan — and is also hidden whenever the entitlements " +
      "fetch fails. A diagnostic must not vanish in the situation you would open " +
      "it. Keep it top-level.",
  );

  // And the render call must not sit inside the entitled branch either.
  const renderIdx = js.indexOf("void renderProbe()");
  assert.ok(renderIdx !== -1, "popup.js must call renderProbe()");
  const sellerFnStart = js.indexOf("function renderSellerSections(");
  const sellerFnEnd = js.indexOf("\n}", sellerFnStart);
  assert.ok(
    !(sellerFnStart !== -1 && sellerFnStart < renderIdx && renderIdx < sellerFnEnd),
    "renderProbe() is called from renderSellerSections, so it only runs for a " +
      "seller-entitled account. Call it unconditionally at init.",
  );
}

console.log(
  "✓ selector-probe: report carries no page content, post-interaction controls " +
    "are not counted as failures, all 5 platforms probe clean, invalid selectors " +
    "are reported rather than thrown",
);
