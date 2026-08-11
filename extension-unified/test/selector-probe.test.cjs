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

// ── 10. The report says whether it was run on the right page (US-2485) ─────
//
// THE PROBLEM THIS FIXES. The first five real reports came back with three
// reading "everything missing" — which looks like three dead channels and was
// actually a seller on the marketplace's home page rather than its sell form.
// Host alone cannot tell those apart, and a report that cannot be interpreted
// is worse than no report, because it produces confident wrong fixes.
{
  const onForm = P.buildProbeReport(SELECTORS, "mercari", matchNone, {
    host: "www.mercari.com",
    origin: "https://www.mercari.com",
    path: "/sell/",
  });
  const listOnForm = onForm.flows.find((f) => f.flow === "list");
  assert.strictEqual(listOnForm.page.onExpectedPage, true);
  assert.ok(/page: yes/.test(P.formatProbeReport(onForm)));

  const offForm = P.buildProbeReport(SELECTORS, "mercari", matchNone, {
    host: "www.mercari.com",
    origin: "https://www.mercari.com",
    path: "/",
  });
  const listOffForm = offForm.flows.find((f) => f.flow === "list");
  assert.strictEqual(listOffForm.page.onExpectedPage, false);
  const offText = P.formatProbeReport(offForm);
  assert.ok(/page: NO/.test(offText), "the wrong page must be called out, loudly");
  assert.ok(
    offText.includes(SELECTORS.mercari.newListingUrl),
    "and it must name the page to open instead — otherwise the reader has to " +
      "go and find it, which is the friction this whole tool exists to remove",
  );

  // A live listing satisfies `delist`, and the sell form does not.
  const onListing = P.buildProbeReport(SELECTORS, "grailed", matchNone, {
    host: "www.grailed.com",
    origin: "https://www.grailed.com",
    path: "/listings/12345",
  });
  assert.strictEqual(
    onListing.flows.find((f) => f.flow === "delist").page.onExpectedPage, true,
  );
  assert.strictEqual(
    onListing.flows.find((f) => f.flow === "list").page.onExpectedPage, false,
  );

  // Vinted's locale map means the sell path is right on any of 22 domains.
  const vinted = P.buildProbeReport(SELECTORS, "vinted", matchNone, {
    host: "www.vinted.fr",
    origin: "https://www.vinted.fr",
    path: "/items/new",
  });
  assert.strictEqual(
    vinted.flows.find((f) => f.flow === "list").page.onExpectedPage, true,
    "a locale domain's sell form must not read as the wrong page",
  );

  // No path supplied → no verdict. Silence beats a guess: claiming the wrong
  // page would dismiss a real break, claiming the right one would send someone
  // hunting a selector on a page that never had it.
  const noPath = P.buildProbeReport(SELECTORS, "mercari", matchNone, { host: "www.mercari.com" });
  assert.strictEqual(noPath.flows[0].page.onExpectedPage, null);
  assert.ok(!/page: /.test(P.formatProbeReport(noPath)));
}

// ── 11. A MISS comes back with what IS on the page ─────────────────────────
{
  // Collected per KIND, and only for the kinds that actually missed — a flow
  // blocked on one text input must not dump every button on the page.
  const asked = [];
  const candidates = (kind) => {
    asked.push(kind);
    return [`${kind}#a[name="a"]`, `${kind}#b[data-testid="B"]`];
  };
  // Miss the title selector WHATEVER it currently is. Matching on its text
  // ("name=\"name\"") tied this test to one revision of the config, and it went
  // green-to-red the day Mercari renamed the field — a false alarm on the file
  // that was correctly updated.
  const found = (sel) => sel !== SELECTORS.mercari.fields.title;
  const flow = P.probeFlow(SELECTORS.mercari, "list", found, { candidates });

  assert.deepStrictEqual(flow.missingRequired, ["title"]);
  assert.deepStrictEqual(asked, ["input"], "only the missing kind should be collected");
  assert.ok(!asked.includes("testids"),
    "a missing text INPUT does not need the page's test attributes — that sweep " +
      "is for the controls we cannot identify by element type");
  const text = P.formatProbeReport({ platform: "mercari", flows: [flow] });
  assert.ok(/what IS on the page/.test(text));
  assert.ok(text.includes('input#a[name="a"]'));

  // A clean flow asks for nothing.
  const clean = P.probeFlow(SELECTORS.mercari, "list", matchAll, { candidates: () => ["x"] });
  assert.strictEqual(clean.candidates, null);
  assert.ok(!/what IS on the page/.test(
    P.formatProbeReport({ platform: "mercari", flows: [clean] }),
  ));

  // On the WRONG page the candidates are the controls of some other page, so
  // printing them would be an invitation to write a selector for the home page.
  const wrongPage = P.probeFlow(SELECTORS.mercari, "list", found, {
    candidates,
    platformCfg: SELECTORS.mercari,
    origin: "https://www.mercari.com",
    path: "/",
  });
  assert.ok(!/what IS on the page/.test(
    P.formatProbeReport({ platform: "mercari", flows: [wrongPage] }),
  ));

  // A collector that throws is a missing section, not a dead report.
  const boom = P.probeFlow(SELECTORS.mercari, "list", found, {
    candidates: () => { throw new Error("detached"); },
  });
  assert.deepStrictEqual(boom.candidates, { input: [] });
  assert.strictEqual(boom.ok, false);
}

// ── 11b. A missing MENU also asks for the page's test attributes ───────────
{
  // THE PROBLEM. Every delist report came back with a dozen header buttons and
  // no listing control, because the control is routinely not a <button>:
  // Poshmark's is `[data-et-name=...]`, and an overflow menu is as often an <a>
  // or a plain <div>. Sweeping buttons cannot find something that is not one.
  // A marketplace does tag its own controls for its own test suite, so the NAME
  // is on the page even when the shape is unguessable.
  const asked = [];
  const candidates = (kind) => { asked.push(kind); return [`${kind}:x`]; };
  const flow = P.probeFlow(SELECTORS.poshmark.delist, "delist", matchNone, { candidates });

  assert.deepStrictEqual(flow.missingRequired, ["menu"]);
  assert.ok(asked.includes("testids"),
    "a missing menu must pull the page's test attributes — the button sweep " +
      "alone has now failed to find a delist control on three marketplaces");
  const text = P.formatProbeReport({ platform: "poshmark", flows: [flow] });
  assert.ok(/\[testids\]/.test(text));
}

// ── 11c. Deep mode describes the controls that only exist after a click ────
{
  // THE GAP. The sweep fires on a missing REQUIRED selector, and a control that
  // only exists after a click is by definition not required — so the two
  // selectors we most needed described were the two that could never be. A
  // seller sat on Mercari's OPEN menu, looking at its Delete button, and on a
  // Poshmark closet with the "Shared" banner still up, and both reports said
  // only "missing, as expected".
  const shallow = [];
  const deep = [];
  const flowShallow = P.probeFlow(SELECTORS.poshmark.delist, "delist", (s) => s.includes("listing-menu"),
    { candidates: (k) => { shallow.push(k); return [k]; } });
  const flowDeep = P.probeFlow(SELECTORS.poshmark.delist, "delist", (s) => s.includes("listing-menu"),
    { candidates: (k) => { deep.push(k); return [k]; }, deep: true });

  // Menu resolves, so nothing is REQUIRED-missing: the shallow run sweeps
  // nothing at all, which is correct on an untouched page.
  assert.ok(flowShallow.ok && flowDeep.ok);
  assert.strictEqual(flowShallow.candidates, null);
  assert.deepStrictEqual(shallow, []);

  // Deep mode describes `remove` and `confirm` anyway — that is the whole point.
  assert.ok(deep.length > 0, "deep mode must sweep for post-interaction misses");
  assert.ok(flowDeep.deep === true, "the flow must record that it ran deep");
  assert.ok(/menu\/dialog included/.test(
    P.formatProbeReport({ platform: "poshmark", flows: [flowDeep] }),
  ), "a deep report must say so, or it reads as the ordinary one");

  // And it stays OPT-IN. On an untouched page those controls SHOULD be missing,
  // and sweeping for them every time would dress a clean report as a broken one.
  const clean = P.probeFlow(SELECTORS.poshmark.delist, "delist", matchAll, { candidates: () => ["x"] });
  assert.strictEqual(clean.candidates, null);
}

// ── 12. The kind mapping reads the selector, not the key ───────────────────
{
  assert.strictEqual(P.candidateKind('textarea[name="description"]'), "textarea");
  assert.strictEqual(P.candidateKind('input[type="file"][accept*="image"]'), "file");
  assert.strictEqual(P.candidateKind('button[data-test="submit"]'), "button");
  assert.strictEqual(P.candidateKind('input[name="name"]'), "input");
  assert.strictEqual(P.candidateKind('[data-et-name="share"]'), "any");
}

// ── 13. The DOM-side collector never reads a value ─────────────────────────
{
  // The pure module cannot enforce this — the collector lives in common.js,
  // where the DOM is. `el.value` is a listing title, a price, a seller's own
  // words; the whole design rests on it never being touched.
  const common = fs.readFileSync(path.join(dir, "lister/common.js"), "utf8");
  const start = common.indexOf("function probeCandidates(");
  const end = common.indexOf("\n  }", start);
  assert.ok(start !== -1 && end > start, "probeCandidates must exist in common.js");
  const body = common.slice(start, end);

  assert.ok(!/\.value\b/.test(body),
    "probeCandidates reads .value. That is what the seller typed — the report " +
      "is written to be pasted into a chat, so it may carry attribute names and " +
      "the site's own button labels and nothing else.");
  assert.ok(!/innerHTML|outerHTML/.test(body),
    "probeCandidates serialises markup, which carries the page wholesale.");
  assert.ok(/PROBE_ATTRS/.test(body),
    "attributes must come from the allowlist, not from el.attributes — an " +
      "open loop would echo whatever a marketplace decides to stash on a node.");

  // The test-attribute sweep is the one place that reads a value off an element
  // it did not select by name, so it gets the same treatment.
  const tStart = common.indexOf("function probeTestIds(");
  const tEnd = common.indexOf("\n  }", tStart);
  assert.ok(tStart !== -1 && tEnd > tStart, "probeTestIds must exist in common.js");
  const tBody = common.slice(tStart, tEnd);
  assert.ok(!/\.value\b|textContent|innerHTML/.test(tBody),
    "probeTestIds reads element content. It may report test-attribute NAMES " +
      "and values — a developer's own identifiers — and nothing else.");
  assert.ok(/PROBE_TEST_ATTRS/.test(tBody),
    "the swept attributes must come from a fixed list, not from el.attributes");

  // THE THIRD ROUND OF REPORTS. Both sweeps returned search, chat,
  // notifications, cart, log out and the category nav, then hit their cap —
  // Mercari's truncated exactly where the item's own section started. The
  // listing control was not missing, it was crowded out by the one part of
  // every page that is identical everywhere.
  for (const [fn, src] of [["probeCandidates", body], ["probeTestIds", tBody]]) {
    assert.ok(/inChrome\(/.test(src),
      `${fn} does not exclude the site header/nav/footer. Those elements are ` +
        "the same on every page of a marketplace, they are never the control " +
        "being hunted, and there are enough of them to fill the cap on their own.");
  }
  assert.ok(/header|\[role=banner\]/.test(common.slice(common.indexOf("PROBE_CHROME"))),
    "PROBE_CHROME must actually name the chrome landmarks");

  // And the allowlist itself must stay a list of UI-chrome attributes.
  const attrs = /var PROBE_ATTRS = \[([\s\S]*?)\];/.exec(common);
  assert.ok(attrs, "PROBE_ATTRS must be declared as a literal list");
  assert.ok(!/"value"|"src"|"href"|"content"/.test(attrs[1]),
    "PROBE_ATTRS admits an attribute that can carry page data or a full URL");
}

// ── 14. The engage flow knows its own page (US-2485 round two) ─────────────
{
  // `closetUrlPattern` lives INSIDE the engage block rather than beside the
  // platform's other URL patterns, so a lookup on the platform config alone
  // finds nothing, prints no verdict, and lets an engage section checked on the
  // create-listing page read as an untested channel. That is what the first
  // real Poshmark report did.
  const onEditor = P.buildProbeReport(SELECTORS, "poshmark", matchNone, {
    host: "poshmark.com",
    origin: "https://poshmark.com",
    path: "/create-listing",
  });
  const engage = onEditor.flows.find((f) => f.flow === "engage");
  assert.strictEqual(engage.page.onExpectedPage, false,
    "the create-listing page is not a closet, and the report must say so");

  const onCloset = P.buildProbeReport(SELECTORS, "poshmark", matchNone, {
    host: "poshmark.com",
    origin: "https://poshmark.com",
    path: "/closet/some-seller",
  });
  assert.strictEqual(
    onCloset.flows.find((f) => f.flow === "engage").page.onExpectedPage, true,
  );
}

// ── 15. Poshmark's wizard: `submit` is a probe, never a click ──────────────
{
  // 2026-08-10: Poshmark rebuilt create-listing as a multi-step wizard. There
  // is no submit button on the first step — the primary action is "Next" — so
  // `submit` now matches it. That is only safe because the fill flow does not
  // submit: it prefills and hands the tab back. If that ever changes, this
  // selector would advance a wizard step and report a listing that was never
  // posted, which is the worst outcome the lister has.
  const common = fs.readFileSync(path.join(dir, "lister/common.js"), "utf8");
  assert.ok(
    /do NOT auto-submit by default/.test(common),
    "common.js no longer documents the no-auto-submit rule. Poshmark's `submit` " +
      "selector points at a wizard's \"Next\" button on the strength of it — " +
      "clicking that would advance a step and report a listing nobody posted.",
  );
  assert.ok(
    !/\.click\(\)/.test(common.slice(common.indexOf("do NOT auto-submit"),
      common.indexOf("do NOT auto-submit") + 900)),
    "something clicks in the block that promises not to submit",
  );
  assert.ok(
    SELECTORS.poshmark.submit.includes('[data-et-name="next"]'),
    "the Poshmark presence probe must cover the wizard's Next button, or every " +
      "fill aborts on a form that is actually there",
  );
}

// ── 16. An unreachable page reloads itself, once ───────────────────────────
{
  // A tab open since before the extension updated is the normal state during a
  // verification session — it happened on the first Mercari check — and the
  // popup can fix it without sending anyone away. Once only: a second failure
  // is real, and reloading again would cost the seller their place on the form.
  const js = fs.readFileSync(path.join(dir, "popup.js"), "utf8");
  assert.ok(/ext\.tabs\.reload\(/.test(js),
    "the probe must reload an unreachable tab rather than only instructing the " +
      "reader to do it by hand");
  assert.strictEqual((js.match(/ext\.tabs\.reload\(/g) || []).length, 1,
    "exactly one reload path — a retry loop would keep wiping the form");
  assert.ok(/even after a reload/.test(js),
    "the second failure must read differently from the first, or the reader " +
      "cannot tell that the automatic retry already happened");

  // The deep checkbox has to reach BOTH probe calls — the first one and the
  // one after the automatic reload. A reload that silently drops the flag
  // would answer a deep request with a shallow report, and the reader has no
  // way to tell those apart.
  const html = fs.readFileSync(path.join(dir, "popup.html"), "utf8");
  assert.ok(/id="probeDeep"/.test(html), "popup.html must carry the deep checkbox");
  const calls = js.match(/askProbe\([^)]*\)/g) || [];
  assert.ok(calls.length >= 2, "expected a probe call and a post-reload retry");
  for (const c of calls) {
    if (!c.includes("block.dataset")) continue;
    assert.ok(/,\s*deep\)/.test(c), `askProbe call drops the deep flag: ${c}`);
  }
}

console.log(
  "✓ selector-probe: report carries no page content, states whether it was run " +
    "on the right page, returns candidate controls for a miss without reading " +
    "any value, post-interaction controls are not counted as failures, all 5 " +
    "platforms probe clean, invalid selectors are reported rather than thrown",
);
