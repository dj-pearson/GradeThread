// GradeThread unified extension — research surface staleness + SPA guards (US-1878).
//
// Two criticals from the audit, both invisible to a manifest/selector test:
//
//   #3 STALE RESULTS. A grade is a multi-second round trip. On an SPA the shopper
//   clicks through mid-flight, and nothing dropped the late response: listing A's
//   score rendered onto listing B's page, and — because the save read
//   location.href AFTER the await — it was RECORDED against B's URL. A wrong grade
//   filed against the wrong item, persisted into the buyer's history.
//
//   #1/#2 SPA INJECTION. The manifest matched detail-page URLs only, so a
//   client-side navigation into a listing injected nothing; and the pushState hook
//   was patched in the content script's ISOLATED WORLD, where it can never observe
//   the page's own pushState. Five of six marketplaces are SPA-first, so the
//   research surface effectively only worked on eBay.
//
// The manifest half is pinned by manifest-hosts.test.cjs. This file pins the parts
// that are pure logic: the epoch/generation discipline, and the fact that the
// shipped script no longer relies on the isolated-world patch.
//
// Zero-dependency node script: throws on mismatch.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const RAW = fs.readFileSync(
  path.resolve(__dirname, "..", "research", "marketplace.js"),
  "utf8",
);

// Strip comments before scanning. The file DOCUMENTS the bugs it fixed — it quotes
// the old `setTimeout(reboot, 300)` and explains why the pushState patch never
// fired — so a naive scan matches the prose and "fails" on a correct file. Only
// executable code is evidence of behaviour.
const SRC = RAW
  // CRLF FIRST. In JavaScript `.` does not match \r, so on a CRLF file the
    // line-comment strip below never reaches end-of-string and comments survive —
    // at which point the guard scans its own documentation and fires on the very
    // words it uses to describe what it forbids. Cost an hour on sync/content.js
    // the day its line endings changed.
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
  .split(/\r?\n/)
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
  .join("\n");

// ── the epoch model, extracted and exercised ───────────────────────────────
// A faithful reproduction of the shipped discipline: capture the epoch before the
// await, drop the response if it moved. Asserting the MODEL keeps this a unit test;
// asserting the SOURCE (below) keeps the shipped file honest to the model.
function makeSurface() {
  const s = {
    epoch: 0,
    rendered: [],
    saved: [],
    invalidate() { s.epoch += 1; },
    async grade(url, resolveWith) {
      const myEpoch = s.epoch;
      const gradedUrl = url; // captured BEFORE the await — this is AC5
      const res = await resolveWith;
      if (myEpoch !== s.epoch) return "dropped";
      s.rendered.push({ url: gradedUrl, score: res.score });
      s.saved.push({ url: gradedUrl, score: res.score });
      return "rendered";
    },
  };
  return s;
}

(async () => {
  // A grade that completes without navigation renders and saves against its own URL.
  {
    const s = makeSurface();
    const out = await s.grade("https://poshmark.com/listing/A", Promise.resolve({ score: 8 }));
    assert.strictEqual(out, "rendered");
    assert.deepStrictEqual(s.saved, [{ url: "https://poshmark.com/listing/A", score: 8 }]);
  }

  // THE BIG ONE: navigate mid-grade → the late response is dropped entirely.
  {
    const s = makeSurface();
    let finish;
    const inflight = new Promise((r) => { finish = r; });
    const p = s.grade("https://poshmark.com/listing/A", inflight);
    s.invalidate(); // the shopper clicked through to listing B
    finish({ score: 8 });
    assert.strictEqual(await p, "dropped", "a stale grade must not render");
    assert.deepStrictEqual(s.rendered, [], "listing A's score must not paint onto listing B");
    assert.deepStrictEqual(s.saved, [], "and must not be recorded at all");
  }

  // AC5: even in a benign race, the saved URL is the one that was GRADED — never
  // whatever the address bar says by the time the response lands.
  {
    const s = makeSurface();
    await s.grade("https://poshmark.com/listing/A", Promise.resolve({ score: 9 }));
    assert.strictEqual(s.saved[0].url, "https://poshmark.com/listing/A");
  }

  // Closing the overlay mid-grade must not let it resurrect.
  {
    const s = makeSurface();
    let finish;
    const p = s.grade("https://x/1", new Promise((r) => { finish = r; }));
    s.invalidate(); // close button / Esc
    finish({ score: 5 });
    assert.strictEqual(await p, "dropped", "a dismissed read must not reappear");
  }

  // Epochs are monotonic: a reused value could resurrect a dropped read.
  {
    const s = makeSurface();
    s.invalidate(); s.invalidate();
    assert.strictEqual(s.epoch, 2);
    assert.ok(s.epoch > 0, "epoch never resets");
  }

  // ── the shipped source honours the model ─────────────────────────────────

  // The isolated-world pushState patch is GONE. Re-adding it would look like it
  // works and silently never fire (the page's history wrapper is a different
  // object), which is exactly how this shipped broken.
  assert.ok(
    !/history\[m\]\s*=/.test(SRC) && !/history\.pushState\s*=/.test(SRC),
    "marketplace.js must NOT monkey-patch history.pushState — a content script's " +
      "isolated world has its own `history` wrapper, so the patch never observes the " +
      "page's navigations (US-1878). Use the Navigation API + the location poll.",
  );

  // The arbitrary post-navigation delay is gone (AC4).
  assert.ok(
    !/setTimeout\(\s*reboot\s*,\s*300\s*\)/.test(SRC),
    "the 300ms post-pushState guess must be gone (US-1878 AC4)",
  );

  // Navigation is observed by mechanisms that actually work from an isolated world.
  assert.ok(/navigation\.addEventListener\(\s*["']navigate["']/.test(SRC),
    "marketplace.js must listen for the Navigation API 'navigate' event");
  assert.ok(/setInterval\(\s*onUrlMaybeChanged/.test(SRC),
    "marketplace.js must keep the location poll as the universal SPA backstop");
  assert.ok(/addEventListener\(\s*["']popstate["']\s*,\s*onUrlMaybeChanged/.test(SRC),
    "popstate must still cover back/forward");

  // The save must not re-read location.href after the await — that is the bug that
  // filed A's score under B's URL.
  assert.ok(
    /url:\s*gradedUrl/.test(SRC),
    "the saved read must use the pre-flight gradedUrl, not location.href (US-1878 AC5)",
  );
  assert.ok(
    !/url:\s*location\.href/.test(SRC),
    "marketplace.js must not save `url: location.href` — by the time a grade resolves " +
      "that can be a different listing (US-1878 AC5)",
  );

  // Both async entry points are epoch-guarded: the grade path AND boot(), which
  // awaits config/settings/cache and could otherwise render a CACHED grade for the
  // previous listing on the new page.
  assert.ok(/if \(myEpoch !== epoch\) return;/.test(SRC), "the grade path is epoch-guarded");
  assert.ok(/const stale = \(\) => myEpoch !== epoch;/.test(SRC), "boot() is epoch-guarded");
  assert.ok(
    (SRC.match(/if \(stale\(\)\) return;/g) || []).length >= 3,
    "every await in boot() (config, settings, recall cache) must be followed by a stale check",
  );

  console.log("research-epoch.test.cjs: staleness + SPA navigation guards all pass");
})();
