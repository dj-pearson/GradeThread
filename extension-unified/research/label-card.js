// GradeThread unified extension — the label reader's card (US-3070 AC2/AC3).
//
// Injected into the active tab by chrome.scripting.executeScript from the
// context-menu handler. That is the whole reason this file looks the way it
// does.
//
// ── EVERY FUNCTION HERE IS SERIALISED, SO NOTHING MAY CLOSE OVER ANYTHING ────
//
// executeScript sends a function's SOURCE to the page and runs it there. The
// page has no GT_LABEL_READER, no GT_CC_SHADOW, no chrome.runtime — nothing the
// worker has. A reference to any of them is not a load error you would see; it
// is a ReferenceError inside somebody else's page, which surfaces as the card
// silently never appearing.
//
// So `render` takes everything it needs as ARGUMENTS and defines every helper
// inside its own body. It looks repetitive next to the rest of this codebase on
// purpose. label-reader.test.cjs asserts the no-closure rule, because the
// failure is invisible from here.
//
// ── WHY scripting AND NOT A CONTENT SCRIPT ──────────────────────────────────
//
// A context-menu click is a qualifying user gesture for `activeTab`, which this
// extension already holds, so this needs NO host permissions and no
// <all_urls> match. The alternative was a content script on every page the user
// visits, which reads as "read and change all your data on all websites" at
// update time — on an extension whose whole job is to look trustworthy on
// somebody else's marketplace.

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api; // node
  if (typeof root !== "undefined") root.GT_LABEL_CARD = api; // worker world
})(typeof self !== "undefined" ? self : this, function () {
  /**
   * Build and mount the card. RUNS IN THE PAGE.
   *
   * @param {object} answer  the shaped read from GT_LABEL_READER.readAnswer
   * @param {object} opts    { rows, siteUrl, ttlMs, hostId } — all plain data
   */
  function render(answer, opts) {
    // ── nothing above this line is available in the page ──────────────────
    if (!answer || !opts) return;
    const HOST_ID = opts.hostId || "gt-label-card";

    // One card at a time. A second right-click replaces the first rather than
    // stacking, because two cards on one page is worse than a stale one.
    const existing = document.getElementById(HOST_ID);
    if (existing) existing.remove();

    const host = document.createElement("div");
    host.id = HOST_ID;
    // Own stacking context, pinned, and out of the page's layout entirely.
    host.setAttribute(
      "style",
      "position:fixed;top:16px;right:16px;z-index:2147483647;all:initial;",
    );
    const root = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = [
      ":host{all:initial}",
      ".c{font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;",
      "background:#fff;color:#1A1A2E;border-radius:14px;padding:14px 16px;width:280px;",
      "box-shadow:0 8px 28px rgba(15,52,96,.22)}",
      ".t{font-weight:700;margin:0 0 8px;font-size:13px;color:#0F3460}",
      ".r{display:flex;justify-content:space-between;gap:10px;padding:5px 0;",
      "border-bottom:1px solid rgba(15,52,96,.08)}",
      ".r:last-of-type{border-bottom:0}",
      ".k{color:#5b6472}",
      ".v{font-weight:600;text-align:right;word-break:break-word}",
      ".b{margin-top:6px;background:none;border:0;padding:2px 4px;color:#0F3460;",
      "font:inherit;font-size:11px;cursor:pointer;text-decoration:underline}",
      ".m{margin:0;color:#5b6472}",
      ".a{display:inline-block;margin-top:10px;color:#0F3460;font-size:12px}",
      ".x{position:absolute;top:8px;right:10px;background:none;border:0;",
      "font:inherit;color:#5b6472;cursor:pointer;padding:2px 6px}",
      "@media (prefers-color-scheme:dark){.c{background:#1A1A2E;color:#f4f5f7}",
      ".t{color:#8fb3e0}.k{color:#a6adb8}.a{color:#8fb3e0}.b{color:#8fb3e0}}",
    ].join("");
    root.appendChild(style);

    const card = document.createElement("div");
    card.className = "c";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "GradeThread label read");

    const close = document.createElement("button");
    close.className = "x";
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close");
    card.appendChild(close);

    const title = document.createElement("p");
    title.className = "t";
    title.textContent = "GradeThread · label read";
    card.appendChild(title);

    function say(text) {
      const p = document.createElement("p");
      p.className = "m";
      p.textContent = text;
      card.appendChild(p);
    }

    // ⚠ A REFUSAL IS AN ANSWER AND RENDERS AS ITSELF. No retry, no spinner: a
    // rate limit the reader cannot see is one they cannot wait out.
    if (answer.state === "rate_limited" || answer.state === "at_capacity" ||
        answer.state === "error") {
      say(answer.message || "Couldn't read that label.");
    } else if (answer.state === "empty") {
      say("Nothing readable on that photo. A straighter, better-lit shot of the tag usually works.");
    } else {
      for (const row of opts.rows || []) {
        const r = document.createElement("div");
        r.className = "r";
        const k = document.createElement("span");
        k.className = "k";
        k.textContent = row.label;
        const v = document.createElement("span");
        v.className = "v";
        v.textContent = row.value;
        r.append(k, v);
        card.appendChild(r);
      }
      const copy = document.createElement("button");
      copy.className = "b";
      copy.type = "button";
      copy.textContent = "Copy all";
      copy.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        const text = (opts.rows || [])
          .map(function (row) { return row.label + ": " + row.value; })
          .join("\n");
        try {
          navigator.clipboard.writeText(text).then(
            function () { copy.textContent = "Copied"; },
            function () { /* blocked; the text is on screen and selectable */ },
          );
        } catch (_e) { /* same */ }
      });
      card.appendChild(copy);

      if (opts.siteUrl) {
        const a = document.createElement("a");
        a.className = "a";
        a.href = opts.siteUrl;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = "Look up this RN";
        card.appendChild(a);
      }
      if (answer.disclaimer) {
        const d = document.createElement("p");
        d.className = "m";
        d.style.marginTop = "8px";
        d.style.fontSize = "11px";
        d.textContent = answer.disclaimer;
        card.appendChild(d);
      }
    }

    root.appendChild(card);
    document.body.appendChild(host);

    // ── it leaves on its own ───────────────────────────────────────────────
    //
    // Escape, the close button, or the TTL. A card that outlives the moment is
    // a thing somebody else's page now has to live with, and this one was never
    // asked for by the site.
    let done = false;
    function dismiss() {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey, true);
      const el = document.getElementById(HOST_ID);
      if (el) el.remove();
    }
    function onKey(e) {
      if (e.key === "Escape") dismiss();
    }
    close.addEventListener("click", dismiss);
    document.addEventListener("keydown", onKey, true);
    setTimeout(dismiss, opts.ttlMs || 60000);
  }

  return { render };
});
