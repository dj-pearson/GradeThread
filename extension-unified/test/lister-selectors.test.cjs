// GradeThread unified extension — lister selector invariants (US-2477..US-2480).
//
// Thin wrapper so the checks in scripts/verify-lister-selectors.mjs run in the
// same lane as every other extension guard (scripts/test-extensions.mjs, wired
// into verify:web and CI). The logic lives in the script rather than here
// because the script is ALSO the thing a human runs by hand:
//
//   node scripts/verify-lister-selectors.mjs --checklist mercari
//
// prints the verification checklist for a platform. Duplicating the invariants
// into a test file would mean the checklist and the gate could disagree, which
// is precisely the failure mode they exist to prevent.
//
// What it enforces, in one line each:
//   • `enabled: true` requires a real `lastVerified` date and a non-draft version
//   • a delist probe never requires a post-interaction selector (US-1875)
//   • `hosts` is non-empty (an empty one silently disables auto-delist)
//   • `liveListingUrlPattern` exists and cannot match the create page itself
//   • every locale in a `locales` map is also a delistable host

const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", "..");
const script = path.join(root, "scripts", "verify-lister-selectors.mjs");

const r = spawnSync(process.execPath, [script], { encoding: "utf8" });

if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);

assert.strictEqual(
  r.status,
  0,
  "verify-lister-selectors reported a problem — see the output above. A flow " +
    "that fails these cannot be trusted to fill a seller's real listing form.",
);

// ── US-2486: the two-page delist contract, asserted on the source ──────────
//
// The ordering rules below cannot be checked from the config, and they are the
// difference between a delist that survives a page load and one that loops.
{
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.resolve(__dirname, "..");
  const common = fs.readFileSync(path.join(dir, "lister", "common.js"), "utf8");
  const sel = (() => {
    const src = fs.readFileSync(path.join(dir, "lister", "selectors.js"), "utf8");
    const scope = {};
     
    return new Function("self", `${src}; return self.GT_LISTER_SELECTORS;`)(scope);
  })();

  // 1. The stage is recorded BEFORE the link is followed. Recording it after
  //    races the page unload, and a lost marker is exactly the loop: the far
  //    page believes it never navigated and clicks a link that is not there.
  const stageAt = common.indexOf("GT_LISTER_STAGE");
  const clickAt = common.indexOf("menu.click()", stageAt);
  assert.ok(stageAt !== -1, "common.js must send GT_LISTER_STAGE");
  assert.ok(
    clickAt > stageAt,
    "the navigation click happens BEFORE the stage is recorded. That races the " +
      "page unload, and a job that navigates without its marker clicks the link " +
      "again on every load until its deadline kills it.",
  );

  // 2. A failed stage message must NOT navigate. Untracked navigation is the
  //    same loop arrived at from the other side.
  const between = common.slice(stageAt, clickAt);
  assert.ok(
    /catch/.test(between) && /manual: true/.test(between),
    "a failed GT_LISTER_STAGE must abort to manual rather than navigating " +
      "untracked — a delist that fails to report beats one that loops.",
  );

  // 3. The far side verifies WHERE it landed before clicking anything.
  assert.ok(
    /navigatesTo, "i"\)\.test\(location\.origin \+ location\.pathname\)/.test(common),
    "the post-navigation branch must check the destination against the " +
      "config's own pattern before it clicks. Origin + pathname, so a query " +
      "string cannot satisfy it.",
  );

  // 4. A deferred run reports nothing. Sending a result would end a job that is
  //    still working, and the seller would be told it failed mid-flight.
  assert.ok(
    /partial && partial\.deferred\) return;/.test(common),
    "runJobForPlatform must not report a deferred (mid-navigation) run",
  );

  // 5. Any platform declaring navigatesTo must declare a valid pattern that its
  //    own live-listing pattern does NOT satisfy — otherwise the flow would
  //    believe it had already arrived while still on the listing.
  for (const [name, cfg] of Object.entries(sel)) {
    const nav = cfg.delist && cfg.delist.navigatesTo;
    if (!nav) continue;
    let re;
    assert.doesNotThrow(() => { re = new RegExp(nav, "i"); },
      `${name}.delist.navigatesTo is not a valid regular expression`);
    assert.ok(
      !re.test("https://" + name + ".com/listing/abc123"),
      `${name}.delist.navigatesTo also matches a plain listing URL, so the far-` +
        "side guard would pass on the page it is meant to reject",
    );
    assert.ok(
      cfg.delist.remove && cfg.delist.confirm,
      `${name}.delist declares navigatesTo but has no remove/confirm to run on ` +
        "the far page, so the navigation leads nowhere",
    );
  }
}
