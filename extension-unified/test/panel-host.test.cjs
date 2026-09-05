// US-3062 AC2: which tabs the panel is offered on.
//
// Two browsers, two mechanisms, one answer. Chromium enables the panel per tab;
// Firefox cannot, so the panel renders its own "open a marketplace tab" state.
// Deciding that twice is how the two start disagreeing, so the rule is one pure
// function and this is what pins it.
//
// THE DIRECTION THAT MATTERS. It fails OPEN: an unparseable or missing URL is
// supported. A panel that wrongly appears costs a glance; a panel that wrongly
// refuses on the listing the seller is looking at costs them the feature and
// reads as broken. Every case below that asserts `true` on bad input is that
// rule, not an oversight.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const scope = { self: {} };
new Function(
  "self",
  fs.readFileSync(path.resolve(__dirname, "..", "panel", "panel-host.js"), "utf8"),
)(scope.self);
const HOST = scope.self.GT_PANEL_HOST;
assert.ok(HOST && HOST.isPanelHost, "panel-host.js must export GT_PANEL_HOST");

// The real selector config, not a fixture. A hand-written host list here would
// pass while the shipped one was wrong, which is the whole failure mode.
const selectorScope = { self: {} };
new Function(
  "self",
  fs.readFileSync(path.resolve(__dirname, "..", "lister", "selectors.js"), "utf8"),
)(selectorScope.self);
const SELECTORS = selectorScope.self.GT_LISTER_SELECTORS;
assert.ok(SELECTORS, "selectors.js must export GT_LISTER_SELECTORS");

// ── the config is actually readable ─────────────────────────────────────────
const hosts = HOST.panelHosts(SELECTORS);
assert.ok(
  hosts.length >= 3,
  `expected several marketplace hosts from selectors.js, got ${hosts.length}. ` +
    `If this parses empty, every "supported" answer below is the fail-open ` +
    `branch and this file is testing nothing.`,
);

// ── marketplaces are supported ──────────────────────────────────────────────
for (const url of [
  "https://poshmark.com/listing/abc-123",
  "https://www.poshmark.com/closet/someone",
  "https://www.mercari.com/us/item/m123/",
]) {
  assert.strictEqual(
    HOST.isPanelHost(url, SELECTORS),
    true,
    `${url} should offer the panel`,
  );
}

// Subdomains count, because marketplaces use them per locale and per surface.
assert.strictEqual(
  HOST.isPanelHost("https://www.vinted.co.uk/items/1", SELECTORS),
  HOST.isPanelHost("https://vinted.co.uk/items/1", SELECTORS),
  "a subdomain must resolve the same as the bare domain",
);

// ── an unrelated site is not ────────────────────────────────────────────────
assert.strictEqual(HOST.isPanelHost("https://example.com/", SELECTORS), false);
assert.strictEqual(
  HOST.isPanelHost("https://news.ycombinator.com/", SELECTORS),
  false,
);

// Our own site is not a panel host: the seller has the whole app there, and a
// sidebar duplicating it beside it is noise.
assert.strictEqual(
  HOST.isPanelHost("https://gradethread.com/dashboard", SELECTORS),
  false,
);
assert.strictEqual(
  HOST.isPanelHost("https://www.gradethread.com/", SELECTORS),
  false,
);

// ── fail open ───────────────────────────────────────────────────────────────
assert.strictEqual(HOST.isPanelHost("", SELECTORS), true, "no URL: fail open");
assert.strictEqual(HOST.isPanelHost(null, SELECTORS), true);
assert.strictEqual(HOST.isPanelHost(undefined, SELECTORS), true);
assert.strictEqual(
  HOST.isPanelHost("not a url", SELECTORS),
  true,
  "an unparseable URL fails OPEN — a panel that wrongly refuses reads as broken",
);
assert.strictEqual(
  HOST.isPanelHost("https://poshmark.com/", null),
  true,
  "no selector config means we cannot tell, which is fail-open, NOT 'no " +
    "marketplaces exist'",
);
assert.strictEqual(HOST.isPanelHost("https://poshmark.com/", {}), true);

// ── platformFor labels the card ─────────────────────────────────────────────
assert.strictEqual(
  HOST.platformFor("https://poshmark.com/listing/x", SELECTORS),
  "poshmark",
);
assert.strictEqual(
  HOST.platformFor("https://www.mercari.com/us/item/m1/", SELECTORS),
  "mercari",
);
assert.strictEqual(HOST.platformFor("https://example.com/", SELECTORS), null);
assert.strictEqual(HOST.platformFor("", SELECTORS), null);
assert.strictEqual(
  HOST.platformFor("https://poshmark.com/", null),
  null,
  "platformFor does NOT fail open — an unknown platform must be null, because " +
    "the item card uses it to decide whether revise is even possible",
);

console.log(
  `✓ panel-host: ${hosts.length} marketplace host(s) from the real selectors, ` +
    `fails open on a URL it cannot read`,
);
