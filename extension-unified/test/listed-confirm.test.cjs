// GradeThread Lister — the cross-post reports itself as published (2026-09-07).
//
// THE BUG THIS COVERS. A fill ends when the marketplace form is prefilled; the
// seller submits minutes later. The background sees that as a tab navigation to
// a live-listing URL — and all it used to do with it was push a message to the
// GradeThread TAB that started the job. A seller who had closed that tab, or who
// queued the cross-post from their phone, got nothing, and the listing stayed a
// draft in FlipDesk until they came back and pressed "I published it" once per
// marketplace.
//
// Now the background tells the SERVER, over its own bearer token, whether or not
// a GradeThread tab exists.
//
// The reporter is EXECUTED here, not grepped for. A source scan would pass just
// as happily against a function that posts to the wrong URL, sends no token, or
// reports a relist twice.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.resolve(__dirname, "..");
const bg = fs.readFileSync(path.join(dir, "background.js"), "utf8");

// ── 1. The wiring exists and is on the non-relist branch ───────────────────

assert.ok(
  /const LISTED_CONFIRM_ENDPOINT\s*=\s*\n?\s*"https:\/\/functions\.gradethread\.com\/api\/grading\/public\/listed-confirm"/
    .test(bg),
  "the listed-confirm endpoint constant is missing or points somewhere else",
);

assert.ok(
  /async function confirmExtensionListed\(itemId, platform, url\)/.test(bg),
  "confirmExtensionListed is gone",
);

// A relist has its own server call (relist-listed) which ends the old row too.
// Reporting a relist through BOTH would activate the copy twice and leave the
// original live, so the ordinary report has to sit in the `else`.
assert.ok(
  /if \(watch\.relistNewListingId\) \{[\s\S]*?\} else \{[\s\S]*?confirmExtensionListed\(watch\.itemId, watch\.platform, url\)/
    .test(bg),
  "a captured live URL must report to the server on the NON-relist branch",
);

// ── 2. The reporter actually runs ──────────────────────────────────────────

/** Pull one top-level `async function NAME(...) { ... }` out of background.js. */
function extractFunction(src, name) {
  const start = src.indexOf(`async function ${name}(`);
  assert.ok(start > -1, `${name} not found`);
  let depth = 0;
  let i = src.indexOf("{", start);
  const open = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} never closed (from ${open})`);
}

const source = extractFunction(bg, "confirmExtensionListed");

/**
 * Run the extracted reporter against stubs.
 *
 * `token` null means storage holds none, which is the signed-out case.
 */
function run({ token, args, fetchImpl }) {
  const calls = [];
  const scope = {
    ext: {
      storage: {
        local: {
          get: async () => (token === null ? {} : { gtBuyerToken: token }),
        },
      },
    },
    LISTED_CONFIRM_ENDPOINT:
      "https://functions.gradethread.com/api/grading/public/listed-confirm",
    fetch: fetchImpl ??
      (async (url, init) => {
        calls.push({ url, init });
        return { ok: true };
      }),
  };
  const fn = new Function(
    "ext",
    "LISTED_CONFIRM_ENDPOINT",
    "fetch",
    `${source}; return confirmExtensionListed;`,
  )(scope.ext, scope.LISTED_CONFIRM_ENDPOINT, scope.fetch);
  return { result: fn(...args), calls };
}

(async () => {
  // The happy path: one POST, bearer token, the three fields the server reads.
  {
    const { result, calls } = run({
      token: "tok-123",
      args: ["item-abc", "poshmark", "https://poshmark.com/listing/xyz-1"],
    });
    assert.strictEqual(await result, true);
    assert.strictEqual(calls.length, 1, "expected exactly one POST");
    const [call] = calls;
    assert.strictEqual(
      call.url,
      "https://functions.gradethread.com/api/grading/public/listed-confirm",
    );
    assert.strictEqual(call.init.method, "POST");
    assert.strictEqual(call.init.headers.Authorization, "Bearer tok-123");
    assert.deepStrictEqual(JSON.parse(call.init.body), {
      item_id: "item-abc",
      platform: "poshmark",
      listing_url: "https://poshmark.com/listing/xyz-1",
    });
  }

  // No token: nothing is sent. A signed-out browser must not fire an
  // unauthenticated write at the API on every navigation it happens to watch.
  {
    const { result, calls } = run({
      token: null,
      args: ["item-abc", "poshmark", "https://poshmark.com/listing/xyz-1"],
    });
    assert.strictEqual(await result, null);
    assert.strictEqual(calls.length, 0);
  }

  // Nothing to attribute the listing to. An item-less report would be a write
  // the server has to guess the target of, and guessing is what put phantom
  // listings in sellers' inventories in the first place.
  for (const args of [
    [null, "poshmark", "https://poshmark.com/listing/xyz-1"],
    ["item-abc", "", "https://poshmark.com/listing/xyz-1"],
    ["item-abc", "poshmark", ""],
  ]) {
    const { result, calls } = run({ token: "tok-123", args });
    assert.strictEqual(await result, null, `should refuse: ${JSON.stringify(args)}`);
    assert.strictEqual(calls.length, 0, `should not POST: ${JSON.stringify(args)}`);
  }

  // The network is down. Fire-and-forget: the seller keeps "I published it",
  // which is exactly where they were before this existed.
  {
    const { result, calls } = run({
      token: "tok-123",
      args: ["item-abc", "poshmark", "https://poshmark.com/listing/xyz-1"],
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    assert.strictEqual(await result, null);
    assert.strictEqual(calls.length, 0);
  }

  // A refusal is an answer, not a crash.
  {
    const { result } = run({
      token: "tok-123",
      args: ["item-abc", "poshmark", "https://poshmark.com/listing/xyz-1"],
      fetchImpl: async () => ({ ok: false, status: 403 }),
    });
    assert.strictEqual(await result, false);
  }

  console.log(
    "listed-confirm.test.cjs: the reporter posts item/platform/url with the " +
      "seller's token, refuses without one, and swallows a dead network",
  );
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
