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
  //
  // NOT COLLECTED, not merely not printed. Suppressing the printing left the
  // DOM walk running and left the signatures sitting in the report OBJECT, and
  // that object is what gets copied and pasted — so a run on a marketplace home
  // page carried a description of that home page's controls that nobody asked
  // for and nothing would ever use.
  asked.length = 0;
  const wrongPage = P.probeFlow(SELECTORS.mercari, "list", found, {
    candidates,
    platformCfg: SELECTORS.mercari,
    origin: "https://www.mercari.com",
    path: "/",
  });
  assert.strictEqual(wrongPage.page.onExpectedPage, false, "the / page is not the sell form");
  assert.deepStrictEqual(asked, [], "the collector must not be called on a wrong page");
  assert.strictEqual(wrongPage.candidates, null, "no signatures ride in the report object");
  assert.ok(!/what IS on the page/.test(
    P.formatProbeReport({ platform: "mercari", flows: [wrongPage] }),
  ));

  // A page the report CANNOT place is still swept: `null` is "cannot tell", and
  // the sweep is the only thing that makes an unplaceable page worth reporting.
  asked.length = 0;
  const unknownPage = P.probeFlow(SELECTORS.mercari, "list", found, { candidates });
  assert.strictEqual(unknownPage.page.onExpectedPage, null);
  assert.deepStrictEqual(asked, ["input"], "a null verdict must not suppress the sweep");

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

  // Stated on EVERY flow, not only where it changed the output. The marker used
  // to appear solely in the candidates header, so a run with the box unticked
  // looked identical to one with it ticked that had nothing to add — and three
  // rounds went by asking for a report that had already been sent without it.
  assert.ok(/deep=off/.test(P.formatProbeReport({ platform: "p", flows: [flowShallow] })),
    "a shallow run must SAY it was shallow, on a flow with nothing to report");
  assert.ok(/deep=on/.test(P.formatProbeReport({ platform: "p", flows: [flowDeep] })));

  // And it stays OPT-IN. On an untouched page those controls SHOULD be missing,
  // and sweeping for them every time would dress a clean report as a broken one.
  const clean = P.probeFlow(SELECTORS.poshmark.delist, "delist", matchAll, { candidates: () => ["x"] });
  assert.strictEqual(clean.candidates, null);
}

// ── 11d. A URL pattern is not a selector (US-2486) ─────────────────────────
{
  // `navigatesTo` was reported to the seller as "INVALID SELECTOR", because
  // every string on a flow was treated as one with two names hard-coded out.
  // A working config read as a broken one. The rule is now positive — known
  // scalars and anything named *Pattern are metadata — so the failure mode
  // stays on the safe side: a genuinely new SELECTOR still gets probed.
  const keys = P.selectorsFor(SELECTORS.poshmark.delist, "delist").map((e) => e.key);
  assert.ok(!keys.includes("navigatesTo"),
    "navigatesTo is a URL pattern; probing it reports our own config as broken");
  assert.ok(!keys.some((k) => /Pattern$/.test(k)), `a *Pattern key leaked in: ${keys}`);
  assert.ok(keys.includes("menu") && keys.includes("remove"),
    "the real selectors must still be probed");

  const text = P.formatProbeReport(P.buildProbeReport(SELECTORS, "poshmark", matchNone, {
    host: "poshmark.com", origin: "https://poshmark.com", path: "/listing/x",
  }));
  assert.ok(!/INVALID SELECTOR/.test(text));
}

// ── 11e. The listing EDITOR is a legitimate page for a delist check ─────────
{
  // On a two-page channel the delete control lives on the editor, so that page
  // is where half the flow happens. It was being reported as the wrong page,
  // which suppressed the candidate sweep — so the one page carrying the answer
  // was the one page the report refused to describe.
  const onEditor = P.buildProbeReport(SELECTORS, "poshmark", matchNone, {
    host: "poshmark.com",
    origin: "https://poshmark.com",
    path: "/edit-listing/abc123",
    candidates: (k) => [`${k}:found`],
  });
  const delist = onEditor.flows.find((f) => f.flow === "delist");
  assert.strictEqual(delist.page.onExpectedPage, true,
    "the listing editor must count as a delist page when the flow navigates to it");
  assert.ok(delist.candidates, "and the candidate sweep must therefore run there");

  // A listing page still counts too — both halves of the flow are legitimate.
  const onListing = P.buildProbeReport(SELECTORS, "poshmark", matchNone, {
    host: "poshmark.com", origin: "https://poshmark.com", path: "/listing/abc123",
  });
  assert.strictEqual(
    onListing.flows.find((f) => f.flow === "delist").page.onExpectedPage, true,
  );

  // Somewhere else is still somewhere else.
  const elsewhere = P.buildProbeReport(SELECTORS, "poshmark", matchNone, {
    host: "poshmark.com", origin: "https://poshmark.com", path: "/feed",
  });
  assert.strictEqual(
    elsewhere.flows.find((f) => f.flow === "delist").page.onExpectedPage, false,
  );
}

// ── 11f. The watcher: catching something that does not stay (US-2487) ──────
{
  // A success toast cannot be described by looking at a page — it is gone
  // before anyone can look. Four rounds of "share, then open the popup, tick
  // the box, press the button" produced four reports of a page the toast had
  // already left. So the watcher records what APPEARED and the next report
  // carries it.
  const appeared = ['div[data-et-name="shared"]', "div[class=\"toast\"]"];
  const report = P.buildProbeReport(SELECTORS, "poshmark", matchAll, {
    host: "poshmark.com", appeared,
  });
  assert.deepStrictEqual(report.appeared, appeared);
  const text = P.formatProbeReport(report);
  assert.ok(/APPEARED while the watcher was armed/.test(text));
  assert.ok(text.includes('div[data-et-name="shared"]'));

  // Reported once for the PAGE, not per flow: a toast belongs to the page, and
  // repeating it under three flows would treble the noise for one fact.
  assert.strictEqual((text.match(/APPEARED while the watcher/g) || []).length, 1);

  // Absent when nothing was watched — an empty section is a section that
  // teaches the reader to skip the area where the answer will appear.
  const quiet = P.buildProbeReport(SELECTORS, "poshmark", matchAll, { host: "poshmark.com" });
  assert.deepStrictEqual(quiet.appeared, []);
  assert.ok(!/APPEARED while the watcher/.test(P.formatProbeReport(quiet)));
}

// ── 11g. The watcher never records TEXT ────────────────────────────────────
{
  // This matters more here than anywhere else in the probe. A toast contains a
  // SENTENCE, and that sentence can name a buyer, a price or a listing — so a
  // watched node is described by its attributes alone, never its text, not
  // even for buttons (which the ordinary sweep does read).
  const common = fs.readFileSync(path.join(dir, "lister/common.js"), "utf8");
  const start = common.indexOf("function watchSignature(");
  const end = common.indexOf("\n  }", start);
  assert.ok(start !== -1 && end > start, "watchSignature must exist in common.js");
  const body = common.slice(start, end);
  assert.ok(!/textContent|innerText|innerHTML|\.value\b/.test(body),
    "watchSignature reads element text. A toast is a sentence about a real " +
      "sale — attributes only.");
  assert.ok(/a === "id"/.test(body),
    "a toast's id is generated per toast, so keeping it makes every appearance " +
      "unique and defeats the dedupe");

  // And it disarms itself. Nothing observes a marketplace page indefinitely.
  const watchStart = common.indexOf("function startWatch(");
  const watchBody = common.slice(watchStart, common.indexOf("\n  }", watchStart) + 4);
  assert.ok(/disconnect\(\)/.test(watchBody) && /setTimeout/.test(watchBody),
    "startWatch must stop on its own timer as well as on the next mutation");
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

  // Poshmark's listing editor tags all ~150 of its style options — 70s,
  // Activewear, Balletcore — with data-et-name, and in document order they
  // filled the entire budget before the page's own controls were reached. So
  // action-shaped names are hoisted, with document order kept inside each group.
  assert.ok(/PROBE_ACTIONISH/.test(tBody),
    "probeTestIds must rank action-shaped names ahead of the rest, or one long " +
      "tag list buries every control on the page");
  const actionish = /var PROBE_ACTIONISH = new RegExp\(([\s\S]*?)\n {2}\);/.exec(common);
  assert.ok(actionish, "PROBE_ACTIONISH must be declared as a literal");
  // Rebuild it and check both directions on the values that caused this.
   
  const re = eval(`new RegExp(${actionish[1].replace(/,\s*$/, "")})`);
  for (const control of [
    "delete_listing", "edit_listing", "modal-close-btn", "confirm-delete",
    "listing_options", "share", "yes", "no",
  ]) {
    assert.ok(re.test(control), `PROBE_ACTIONISH misses the control "${control}"`);
  }
  for (const noise of [
    "70s", "Activewear", "Monochrome", "Notifications", "Trending", "Cottagecore",
  ]) {
    assert.ok(!re.test(noise),
      `PROBE_ACTIONISH hoists the content tag "${noise}". Bare \`no\` matches ` +
        "Monochrome and bare `end` matches Trending — so the very tags this " +
        "ranking demotes would be lifted above the controls. A loose ranking is " +
        "worse than none: it looks like it worked.");
  }
  assert.ok(/hits\.concat\(rest\)/.test(tBody),
    "ranking must CONCATENATE, not filter: a control we failed to anticipate " +
      "still has to appear, just lower down");

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

  // Repeated controls must collapse. A Grailed listing page spent 11 of its 20
  // candidate slots on the follow-heart of each RELATED listing — identical but
  // for `id` — and the page's own Delete button never made the cut. So the
  // dedupe key drops `id` while the printed line keeps it.
  assert.ok(/var dedupe = /.test(body) && /if \(a !== "id"\)/.test(body),
    "probeCandidates must dedupe on a key that ignores `id`, or one repeated " +
      "control floods the list and hides the one being hunted");
  assert.ok(/seen\[dedupe\] = true/.test(body),
    "the dedupe key must be the one recorded, or nothing is collapsed at all");

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
  // 2026-08-16 (US-2624): this used to pin the exact phrase "do NOT auto-submit
  // by default", and "by default" was wrong — it implied an option. runFlow took
  // an `opts` argument, every call site passed { autoSubmit: false }, and the
  // function never read it. So the flag read as the reason nothing gets clicked
  // while the real reason was that no code clicks. The argument is gone, and the
  // guard now checks the RULE rather than one sentence: the block must still
  // discuss auto-submit, must not click, and runFlow must not grow an option.
  const common = fs.readFileSync(path.join(dir, "lister/common.js"), "utf8");
  const at = common.indexOf("auto-submit");
  assert.ok(
    at > -1,
    "common.js no longer documents the no-auto-submit rule. Poshmark's `submit` " +
      "selector points at a wizard's \"Next\" button on the strength of it — " +
      "clicking that would advance a step and report a listing nobody posted.",
  );
  assert.ok(
    !/\.click\(\)/.test(common.slice(at, at + 900)),
    "something clicks in the block that promises not to submit",
  );
  assert.ok(
    /GT\.runFlow = async function \(flow, payload\) \{/.test(common),
    "runFlow grew a third argument. If that is an auto-submit option, the " +
      "Poshmark `submit` selector points at a wizard's Next button and this " +
      "test is the only thing standing between a caller and a phantom listing.",
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

// ── US-2698: the SOLD-SYNC probe ───────────────────────────────────────────
//
// The sync reads describe the seller's Sold page and their closet. The Sold
// page has the BUYER's name and shipping address printed on it, so the
// no-page-content rule matters more here than anywhere else in the extension:
// this report is written to be pasted into a chat.
{
  const SYNC = load("sync/selectors.js", "GT_SYNC_SELECTORS");

  // Every selector the sync flows declare is actually probed. Before US-2698
  // the non-list branch only walked TOP-LEVEL strings, so a flow's `fields`
  // map went unprobed entirely and the report claimed a clean sold flow while
  // testing one selector.
  const clean = P.buildSyncProbeReport(SYNC, "poshmark", matchAll, { host: "poshmark.com" });
  assert.strictEqual(clean.kind, "sync");
  assert.strictEqual(clean.flows.length, 2, "expected a sold flow and a closet flow");

  const soldFlow = clean.flows.find((f) => f.flow === "sold");
  const keys = soldFlow.entries.map((x) => x.key).sort();
  for (const expected of ["row", "listingUrl", "title", "priceText", "dateText", "orderRef"]) {
    assert.ok(keys.includes(expected), `sold flow does not probe "${expected}" — got ${keys.join(", ")}`);
  }
  assert.ok(clean.flows.every((f) => f.ok), "a page where everything resolves must report clean");

  // The closet flow must probe the ownership tell, since that is the control
  // deciding whether this closet is the seller's own.
  const closetFlow = clean.flows.find((f) => f.flow === "closet");
  assert.ok(
    closetFlow.entries.some((x) => x.key === "ownClosetTell" && x.required),
    "the closet probe must test ownClosetTell as REQUIRED",
  );

  // The report states the enable posture, because a clean report is what earns
  // a lastVerified date and the reader needs to know none is set yet.
  assert.strictEqual(clean.enabled, false);
  assert.strictEqual(clean.lastVerified, null);
  assert.ok(clean.version, "the report must name the selector version");

  // No page content, and specifically no buyer identity.
  const SECRETS = [
    "Jane Doe",
    "1 Main Street, Springfield",
    "seller-handle-42",
    "https://poshmark.com/listing/abc123",
    "Vintage Nike windbreaker size L",
  ];
  const serialized = JSON.stringify(clean) + "\n" + P.formatProbeReport(clean);
  for (const secret of SECRETS) {
    assert.ok(
      !serialized.includes(secret),
      `the sold-sync probe report leaked page content: ${secret}`,
    );
  }
  assert.ok(!/\/order\/sales/.test(serialized) || !/https:\/\//.test(serialized),
    "the report must not carry a full URL");

  // A miss is reported rather than thrown, same as the lister probe.
  const missed = P.buildSyncProbeReport(SYNC, "poshmark", matchNone, { host: "poshmark.com" });
  assert.ok(missed.flows.every((f) => !f.ok), "a page where nothing resolves must report NOT clean");

  // An unknown platform is an error on the report, not an exception.
  const unknown = P.buildSyncProbeReport(SYNC, "depop", matchAll, { host: "depop.com" });
  assert.ok(unknown.error, "an unbundled platform must report an error");
  assert.deepStrictEqual(unknown.flows, []);
}

// ── US-2739: the price dialog is PROBED ────────────────────────────────────
//
// It was not, on any run, on any platform. The walker only pushed STRING values
// and `priceDialog` is an object, so its three selectors were skipped in
// silence while the deep report said the Poshmark list flow probed clean. The
// one selector in the whole flow that was INFERRED rather than read off the
// page is the one nothing was measuring - and a live send on 2026-08-20 came
// back "could NOT set the price", which is what a dialog that never opened
// looks like.
{
  const keys = P.selectorsFor(SELECTORS.poshmark, "list").map((e) => e.key);
  assert.ok(
    keys.includes("priceDialog.open"),
    "priceDialog.open is not probed. It is the create-page control the seller " +
      "clicks to reach the price, and the only inferred selector in the flow.",
  );
  assert.ok(
    keys.includes("priceDialog.price"),
    "the modal's own price input is not probed",
  );

  const entries = P.selectorsFor(SELECTORS.poshmark, "list");
  const opener = entries.find((e) => e.key === "priceDialog.open");
  assert.strictEqual(
    opener.postInteraction,
    false,
    "the OPENER is a create-page control. Marking it post-interaction would " +
      "excuse the exact miss this is here to catch.",
  );
  for (const key of ["priceDialog.price", "priceDialog.originalPrice"]) {
    assert.strictEqual(
      entries.find((e) => e.key === key).postInteraction,
      true,
      `${key} lives inside the modal and cannot resolve until it opens; ` +
        "reporting it as a failure buries the one line that matters",
    );
  }

  // The allowlist, not "every object-valued key". `delist` and `engage` are
  // their own flows probed on their own pages, and walking them into the list
  // report would bury it under two dozen expected misses.
  const strays = keys.filter((k) => k.startsWith("delist.") || k.startsWith("engage."));
  assert.deepStrictEqual(
    strays,
    [],
    "the list probe walked another flow's selectors: " + strays.join(", "),
  );

  // Every other platform is unaffected: no groups, no new keys.
  for (const plat of ["mercari", "grailed", "vinted", "facebook"]) {
    const other = P.selectorsFor(SELECTORS[plat], "list").map((e) => e.key);
    assert.deepStrictEqual(
      other.filter((k) => k.includes(".")),
      [],
      `${plat} grew nested probe keys it does not declare`,
    );
  }
}

console.log(
  "✓ selector-probe: report carries no page content, states whether it was run " +
    "on the right page, returns candidate controls for a miss without reading " +
    "any value, post-interaction controls are not counted as failures, all 5 " +
    "platforms probe clean, invalid selectors are reported rather than thrown, " +
    "and the sold-sync flows probe every field without carrying buyer identity",
);
