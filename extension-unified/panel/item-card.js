// US-3062: the item the seller is listing, beside the form they are filling.
//
// The view model is pure and separated from the DOM for the reason the rest of
// this extension separates them: what the card SAYS is a set of rules about
// missing data (no grade, no comps, a platform that cannot be revised), and
// those rules are only testable if they are not tangled with element creation.
//
// THE RULE THIS EXISTS TO HOLD. An absent grade is not a bad grade, and an
// unread comp set is not "no comps". Both render as an explicit absence with a
// way to fix it, never as a zero, a dash or an empty list — a seller who reads
// "0" next to Grade will price against a number nobody produced.

(function (root) {
  "use strict";

  /** Platforms whose revise/relist blocks are wired. Mirrors lister/selectors.js. */
  var REVISABLE = ["poshmark", "mercari"];

  /**
   * What the card should show, from whatever the background could answer.
   *
   * `kind`:
   *   "none"    - no item for this tab. Not an error; most tabs have none.
   *   "unknown" - we could not tell. Different from "none" and must stay so:
   *               "open a listing" over a failed read sends the seller looking
   *               for a listing they already have open.
   *   "item"    - an item, with whatever of its fields exist.
   */
  function viewFor(res) {
    if (!res || res.ok !== true) {
      return { kind: res === null ? "unknown" : "unknown", item: null };
    }
    if (!res.item) return { kind: "none", item: null };

    var it = res.item;
    var platform = typeof it.platform === "string" ? it.platform.toLowerCase() : "";
    return {
      kind: "item",
      item: {
        id: it.id || "",
        title: it.title || "Untitled item",
        // A grade is a number or it is absent. Never 0: the scale starts at 1.0,
        // so a 0 on this card can only mean "we did not read one".
        grade: typeof it.grade === "number" && it.grade > 0 ? it.grade : null,
        certificateId: it.certificateId || null,
        targetPriceCents: typeof it.targetPriceCents === "number" &&
            it.targetPriceCents > 0
          ? it.targetPriceCents
          : null,
        // An empty array and a missing one are different answers. Null means
        // nobody looked; [] means we looked and the market is thin.
        comps: Array.isArray(it.comps) ? it.comps : null,
        platform: platform,
        canRevise: REVISABLE.indexOf(platform) !== -1 && Boolean(it.id),
        // The selectors module's own sentence for why a platform is off, so the
        // panel does not invent a second wording for the same fact.
        disabledReason: it.disabledReason || null,
      },
    };
  }

  /**
   * The pending-revise row for this item, or null.
   *
   * A revise payload's `fields` is the set of things a FlipDesk edit made
   * stale, computed by the server. The panel must never invent it: a revise
   * with guessed fields rewrites a live listing with values nobody asked to
   * change. So Revise is offered only when a real row exists, and this is the
   * function that decides that.
   *
   * Matched on the item id, and on nothing else. Matching by listing URL would
   * look equivalent and is not: the same garment can be listed twice on one
   * marketplace, and a revise aimed at the wrong copy is silent.
   */
  function pendingFor(res, view) {
    if (!res || res.ok !== true || !Array.isArray(res.pending)) return null;
    if (!view || view.kind !== "item" || !view.item.id) return null;
    for (var i = 0; i < res.pending.length; i++) {
      var row = res.pending[i];
      if (!row || typeof row !== "object") continue;
      var id = row.itemId || row.inventory_item_id || null;
      if (id && id === view.item.id) {
        // Only a row the background can actually send. A row missing either
        // half fails isValidRevisePayload, and a button that always errors is
        // worse than one that is not offered.
        var hasFields = Array.isArray(row.fields) && row.fields.length > 0;
        var hasUrl = typeof row.listingUrl === "string" && row.listingUrl !== "";
        return hasFields && hasUrl ? row : null;
      }
    }
    return null;
  }

  function money(cents) {
    if (typeof cents !== "number") return null;
    return "$" + (cents / 100).toFixed(2);
  }

  function render(host, view, handlers) {
    if (!host) return;
    host.textContent = "";
    var h = handlers || {};

    if (view.kind === "unknown") {
      var u = document.createElement("p");
      u.className = "pop-muted";
      u.textContent = "Could not check this tab.";
      host.appendChild(u);
      return;
    }
    if (view.kind === "none") {
      var n = document.createElement("p");
      n.className = "pop-muted";
      n.textContent = "Open a marketplace listing to see the item here.";
      host.appendChild(n);
      return;
    }

    var it = view.item;

    var title = document.createElement("p");
    title.className = "gt-panel-item-title";
    title.textContent = it.title;
    host.appendChild(title);

    var facts = document.createElement("dl");
    facts.className = "gt-panel-facts";

    function fact(label, value, muted) {
      var dt = document.createElement("dt");
      dt.textContent = label;
      var dd = document.createElement("dd");
      dd.textContent = value;
      if (muted) dd.className = "pop-muted";
      facts.appendChild(dt);
      facts.appendChild(dd);
    }

    if (it.grade != null) {
      fact("Grade", it.grade.toFixed(1), false);
    } else {
      fact("Grade", "Not graded", true);
    }
    if (it.certificateId) fact("Certificate", it.certificateId, false);
    var price = money(it.targetPriceCents);
    fact("Target price", price || "Not set", !price);
    if (it.comps == null) {
      fact("Sold comps", "Not read", true);
    } else if (it.comps.length === 0) {
      fact("Sold comps", "None found", true);
    } else {
      fact("Sold comps", String(it.comps.length), false);
    }
    host.appendChild(facts);

    var actions = document.createElement("div");
    actions.className = "gt-panel-actions";

    // Revise. Enabled only when the platform is wired AND a real pending row
    // exists; every disabled state names its own reason, because a dead button
    // with no sentence reads as a broken extension rather than as nothing to do.
    var revise = document.createElement("button");
    revise.type = "button";
    revise.className = "pop-btn";
    revise.textContent = "Revise";
    var reviseWhy = null;
    if (!it.canRevise) {
      reviseWhy = it.disabledReason || "Not available on this marketplace yet.";
    } else if (!h.pending) {
      reviseWhy = "Nothing to update on this listing.";
    }
    if (reviseWhy) {
      revise.disabled = true;
      revise.title = reviseWhy;
    } else if (h.onRevise) {
      revise.addEventListener("click", function () {
        revise.disabled = true;
        h.onRevise();
      });
    }
    actions.appendChild(revise);

    // Relist is a LINK. Its payload names the new listing row the server
    // creates for the copy, which does not exist until FlipDesk makes it, so
    // firing a message here could only ever be refused.
    if (h.relistHref) {
      var relist = document.createElement("a");
      relist.className = "pop-btn pop-btn-ghost";
      relist.href = h.relistHref;
      relist.target = "_blank";
      relist.rel = "noopener";
      relist.textContent = "Relist in FlipDesk";
      actions.appendChild(relist);
    }

    host.appendChild(actions);

    if (reviseWhy) {
      var why = document.createElement("p");
      why.className = "pop-muted";
      why.textContent = reviseWhy;
      host.appendChild(why);
    }
  }

  root.GT_PANEL_ITEM_CARD = {
    viewFor: viewFor,
    pendingFor: pendingFor,
    render: render,
    REVISABLE: REVISABLE,
  };
})(typeof self !== "undefined" ? self : globalThis);
