// GradeThread unified extension — the return shield's page boot (US-3068).
//
// Split from research/return-shield.js so that file stays free of chrome.* and
// document globals and can be driven from node. This is the thin half: decide
// whether the page qualifies, ask the background once, and mount what
// return-shield.js builds.
//
// ── ONCE PER PAGE, NEVER RETRIED ─────────────────────────────────────────────
//
// Every failure — no token, offline, 404, 500, a malformed body — renders
// nothing and does not ask again. A 404 in particular is an ANSWER: it means a
// return this workspace does not own. And a seller reading a dispute must not
// have a GradeThread panel appear four seconds late on a retry, on the page
// where they are deciding whether to refund somebody.
//
// ── IT TOUCHES NOTHING OF EBAY'S ─────────────────────────────────────────────
//
// It appends one host element to the body and reads location.href. No eBay
// element is queried, clicked, filled or submitted.

(function () {
  const SHIELD = self.GT_RETURN_SHIELD;
  const SHADOW = self.GT_CC_SHADOW;
  const CSS = self.GT_CC_CSS;
  const FMT = self.GT_CC_FMT;
  const ATTR = self.GT_ATTRIBUTION;
  if (!SHIELD || !SHADOW || !FMT) return;

  const HOST_ID = "gt-return-shield";
  let done = false;

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg);
    } catch (_e) {
      return Promise.resolve(null); // worker asleep / context invalidated
    }
  }

  async function copyDraft(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = FMT.STRINGS.shieldCopied;
      setTimeout(function () {
        button.textContent = FMT.STRINGS.shieldCopy;
      }, 2000);
    } catch (_e) {
      // Clipboard blocked. The draft is on screen and selectable, so there is
      // nothing to say and nothing to fix.
    }
  }

  async function boot() {
    if (done) return;
    const returnId = SHIELD.returnIdFromUrl(location.href);
    if (!returnId) return;
    // Marked BEFORE the round trip: an SPA navigation inside Seller Hub must not
    // start a second request for the same page.
    done = true;

    const res = await send({ type: "GT_RETURN_PACK", returnId: returnId });
    if (!res || !res.ok) return; // absence is not a claim
    const answer = SHIELD.readAnswer(res.data);
    if (!answer) return;

    if (document.getElementById(HOST_ID)) return;
    const mounted = SHADOW.createOverlayHost(document, HOST_ID, CSS);
    const panel = SHIELD.buildPanel({
      doc: document,
      strings: FMT.STRINGS,
      copy: copyDraft,
      flipdeskUrl: function () {
        return ATTR && typeof ATTR.siteUrl === "function"
          ? ATTR.siteUrl("/dashboard/flipdesk/post-sale", "return-shield")
          : null;
      },
    }, answer);
    if (!panel) return;
    mounted.root.appendChild(panel);
    try {
      document.body.appendChild(mounted.host);
    } catch (_e) { /* detached document — drop the panel */ }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      void boot();
    });
  } else {
    void boot();
  }
})();
