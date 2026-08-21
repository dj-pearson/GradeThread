// GradeThread Lister — one-click selector check (US-2484).
//
// WHY THIS EXISTS. Enabling a marketplace flow is the one step in
// vault/30-platform/closing-a-coverage-gap.md that a machine cannot do: every
// sell form is behind a login, so "re-verify the selectors" means a human with
// an account loading the real page. Until now that meant working down a
// printed checklist, pasting a dozen querySelector calls into devtools, and
// reading the results back by hand — per channel, and again every time a
// marketplace moves its form (the selectors file says to assume that monthly
// for Mercari).
//
// That cost is why five channels sat written-but-switched-off. This turns the
// job into: open the sell form, click Check in the popup, paste the report.
//
// THE REPORT IS THE PRODUCT, and it is designed to be pasted into a chat or an
// issue by someone who has not read this file. So it carries ONLY:
//   • the platform, the flow, and the selector VERSION being tested;
//   • the page's HOST — never the full URL, which on a listing page carries an
//     item id, and on some marketplaces a seller identifier;
//   • per selector: its key, whether it is required, whether it matched, and
//     the selector string itself (our own config, not page data).
//
// It carries NO page content: no titles, no prices, no handles, nothing typed
// into the form. A seller pasting this is not pasting their listing. That is a
// deliberate constraint and selector-probe.test.cjs holds it.
//
// TWO THINGS THE FIRST ROUND OF REPORTS PROVED WERE MISSING (US-2485).
//
//  1. A MISS is only evidence if the seller was on the right page, and the
//     report could not say which page they were on — host alone does not
//     distinguish mercari.com/sell from mercari.com. Three of the first five
//     reports were "everything missing", which reads as a broken channel and is
//     far more likely to be the wrong tab. So each flow now states whether the
//     page LOOKS like the one it tests, derived from the bundled config, and
//     names the page to open when it does not. It compares paths and reports a
//     verdict — the path itself never appears.
//
//  2. A MISS told us a selector broke but nothing about what replaced it, so
//     every fix was a guess followed by another round-trip. When a REQUIRED
//     selector misses, the report now lists the candidate controls actually on
//     the page, as attribute signatures. Attribute NAMES and values from our
//     allowlist only (name, id, type, role, aria-label, placeholder, and the
//     data-test* family), plus a button's own label text — all of it site UI
//     chrome, none of it what the seller typed. Field values are never read.


//
// Pure by construction: `matches` is injected, so this file has no DOM, no
// chrome.* and no network, and the tests exercise every branch without a
// browser.

(function (root) {
  "use strict";

  /** Selector keys that only exist AFTER an interaction, per flow. */
  var POST_INTERACTION = {
    delist: ["remove", "confirm"],
    engage: [
      // `shareInternal` lives in the first share modal, `shareToFollowers` in
      // the second — both post-interaction, neither present on a closet at rest.
      "shareInternal", "shareToFollowers", "offerPriceInput", "offerSubmit",
      "actionConfirmed",
    ],
    // US-2739: the price dialog. `priceDialog.open` is a create-page control and
    // must resolve; its two inputs live inside the modal and cannot, until it is
    // opened. Reporting those two as failures would bury the one line that
    // matters.
    list: ["priceDialog.price", "priceDialog.originalPrice"],
  };

  /**
   * Nested selector groups that belong to the LIST flow.
   *
   * An allowlist, not "every object-valued key". The platform config also holds
   * `delist` and `engage`, which are their own flows probed on their own pages —
   * walking them here would bury the create-page report under two dozen misses
   * that are all expected.
   */
  var LIST_GROUPS = ["priceDialog"];

  /**
   * The selectors a flow declares, flattened to {key, selector, required}.
   *
   * The three flows nest differently in selectors.js — `list` puts them under
   * `fields` plus a top-level `submit`, `delist` and `engage` put them at the
   * top level — so this is the one place that shape is untangled.
   */
  function selectorsFor(cfg, flow) {
    var out = [];
    var required = (cfg && cfg.required) || [];
    var seen = {};

    function push(key, selector) {
      if (!selector || seen[key]) return;
      seen[key] = true;
      out.push({
        key: key,
        selector: String(selector),
        required: required.indexOf(key) !== -1,
        // Reported so the human is not confused when a control legitimately
        // does not resolve yet — see the note in formatProbeReport.
        postInteraction: (POST_INTERACTION[flow] || []).indexOf(key) !== -1,
      });
    }

    if (flow === "list") {
      var fields = (cfg && cfg.fields) || {};
      Object.keys(fields).forEach(function (k) { push(k, fields[k]); });
      push("submit", cfg && cfg.submit);
      // US-2739: nested selector GROUPS, of which `priceDialog` is the first.
      //
      // The walker below only ever pushed STRING values, so an object-valued key
      // was skipped in silence — and priceDialog is an object. Its three
      // selectors have therefore never been probed, on any run, while the deep
      // report said the Poshmark list flow probed clean. The one selector in the
      // whole flow that was INFERRED rather than read off the page is the one
      // nothing was measuring.
      //
      // Keys are dotted (`priceDialog.open`) so a miss names which group it came
      // from, and so POST_INTERACTION can speak about one member of a group.
      LIST_GROUPS.forEach(function (k) {
        var group = cfg && cfg[k];
        if (!group || typeof group !== "object" || Array.isArray(group)) return;
        Object.keys(group).forEach(function (gk) {
          if (typeof group[gk] !== "string") return;
          if (/Pattern$/.test(gk) || /Url$/.test(gk) || /^navigatesTo$/.test(gk)) return;
          if (gk === "version" || gk === "lastVerified" || gk === "enabled") return;
          push(k + "." + gk, group[gk]);
        });
      });
    } else {
      // Every string on a flow used to be treated as a selector, with two names
      // hard-coded out. That is backwards: adding ANY new string key to a flow
      // silently turns it into a selector, and US-2486's `navigatesTo` did
      // exactly that — a URL pattern was reported to the seller as an INVALID
      // SELECTOR, which reads like a broken config rather than a working one.
      //
      // So the rule is now positive: a key is metadata if it is one of the
      // known scalars, or if it NAMES a URL pattern. Everything else is a
      // selector, which keeps the failure mode on the safe side — a genuinely
      // new selector still gets probed rather than being silently skipped.
      Object.keys(cfg || {}).forEach(function (k) {
        if (typeof cfg[k] !== "string") return;
        if (k === "version" || k === "lastVerified") return;
        // US-2698/US-2701: `…Url` joins `…Pattern` and `navigatesTo` as
        // metadata. `pollUrl` arrived on the sold-sync flow and was treated as a
        // selector — the probe would have tried to querySelector a URL, and,
        // worse, printed the full address into a report whose whole contract is
        // that it carries no page address. selector-probe.test.cjs caught it.
        if (/Pattern$/.test(k) || /Url$/.test(k) || /^navigatesTo$/.test(k)) return;
        push(k, cfg[k]);
      });
      // US-2698: a non-list flow may ALSO carry a `fields` map. The sold-sync
      // flows do — a Sold row's title, price and date are per-row selectors, the
      // same shape the list flow uses for form inputs. Walking it here is a
      // no-op for every lister delist/engage flow (none has one) and is what
      // lets the sync flows be probed at all rather than reporting one selector.
      var nestedFields = (cfg && cfg.fields) || {};
      Object.keys(nestedFields).forEach(function (k) { push(k, nestedFields[k]); });
    }
    return out;
  }

  /**
   * Which kind of control a selector is looking for.
   *
   * Used only to decide which candidates to show beside a MISS: offering every
   * button on a Poshmark page as a replacement for `title` would bury the two
   * lines that matter. Read off the selector string rather than the key name,
   * because the key is ours and the selector is what has to match the page.
   */
  function candidateKind(selector) {
    var s = String(selector || "").toLowerCase();
    if (s.indexOf("textarea") !== -1) return "textarea";
    if (s.indexOf("type=\"file\"") !== -1 || s.indexOf("type='file'") !== -1) return "file";
    if (s.indexOf("select") === 0 || s.indexOf(" select") !== -1) return "select";
    if (s.indexOf("button") !== -1 || s.indexOf("[role=\"button\"]") !== -1) return "button";
    if (s.indexOf("input") !== -1) return "input";
    return "any";
  }

  /** Strip a full URL down to its path, so a locale host never leaks in. */
  function pathOf(url) {
    var s = String(url || "");
    var m = /^https?:\/\/[^/]+(\/[^?#]*)/.exec(s);
    if (m) return m[1];
    return s.indexOf("/") === 0 ? s.split("?")[0].split("#")[0] : null;
  }

  function samePath(a, b) {
    if (!a || !b) return false;
    var x = a.replace(/\/+$/, "");
    var y = b.replace(/\/+$/, "");
    return x === y || x.indexOf(y + "/") === 0;
  }

  /**
   * Is this the page the flow is meant to be checked on?
   *
   * Returns `null` for "cannot tell" — no path was supplied, or the config
   * carries no pattern for that flow — and a null verdict prints nothing. A
   * guess here would be worse than silence: it would either dismiss a real
   * break as a wrong tab, or send someone hunting a selector on a page that
   * never had it.
   */
  function pageCheck(cfg, flow, ctx) {
    var path = ctx && ctx.path;
    var out = { onExpectedPage: null, open: null, what: null };
    if (!path || !cfg) return out;

    if (flow === "list") {
      out.what = "the new-listing form";
      var urls = [];
      if (cfg.locales) {
        Object.keys(cfg.locales).forEach(function (k) { urls.push(cfg.locales[k]); });
      }
      if (cfg.newListingUrl) urls.push(cfg.newListingUrl);
      if (urls.length === 0) return out;
      out.open = cfg.newListingUrl || urls[0];
      out.onExpectedPage = urls.some(function (u) { return samePath(path, pathOf(u)); });
      return out;
    }

    // `closetUrlPattern` sits INSIDE the engage block, not beside the platform's
    // other URL patterns — so both objects are consulted. Getting this wrong is
    // silent: pageCheck returns null, the report prints no verdict, and the
    // engage section reads as an untested channel rather than a wrong page.
    var flowCfg = (ctx && ctx.flowCfg) || {};
    var patterns = [];
    if (flow === "engage") {
      out.what = "your own closet";
      patterns.push(flowCfg.closetUrlPattern || cfg.closetUrlPattern);
    } else {
      out.what = "one of your own live listings";
      patterns.push(flowCfg.liveListingUrlPattern || cfg.liveListingUrlPattern);
      // US-2486: on a two-page channel the delete control lives on the LISTING
      // EDITOR, so that page is a legitimate place to run this check — it is
      // where half the flow actually happens. Without this the editor was
      // reported as the wrong page and the candidate sweep was suppressed,
      // which meant the one page carrying the answer was the one page the
      // report refused to describe.
      if (flowCfg.navigatesTo) {
        patterns.push(flowCfg.navigatesTo);
        out.what = "one of your own live listings, or its editor";
      }
    }
    patterns = patterns.filter(Boolean);
    if (patterns.length === 0 || !ctx.origin) return out;

    var url = String(ctx.origin) + path;
    var verdict = false;
    for (var i = 0; i < patterns.length; i++) {
      try {
        // These patterns are anchored at `^https://`, so they are matched
        // against origin + path. The query string is left off on purpose: it is
        // the part that carries referral and session-shaped junk, and no
        // pattern needs it.
        if (new RegExp(patterns[i], "i").test(url)) { verdict = true; break; }
      } catch (_err) {
        return { onExpectedPage: null, open: out.open, what: out.what };
      }
    }
    out.onExpectedPage = verdict;
    return out;
  }

  /**
   * Run one flow's selectors through `matches` and score the result.
   *
   * `matches(selector)` returns true when the page has at least one element for
   * it. Injected rather than called directly so this stays testable and so the
   * caller decides how to look (querySelector, a shadow-root walk, whatever a
   * future marketplace forces on us).
   */
  function probeFlow(cfg, flow, matches, ctx) {
    var entries = selectorsFor(cfg, flow).map(function (e) {
      var found = false;
      try {
        found = Boolean(matches(e.selector));
      } catch (_err) {
        // An invalid selector is a REPORTABLE result, not a crash. A typo in
        // the config is exactly the kind of thing this is meant to surface.
        found = false;
        e.invalid = true;
      }
      e.found = found;
      return e;
    });

    // Only a missing REQUIRED selector blocks the flow — that is the same rule
    // probe() enforces at runtime, so the report and the runtime agree about
    // what "broken" means.
    var missingRequired = entries.filter(function (e) {
      return e.required && !e.found;
    });
    // A missing post-interaction control is expected on a page where nothing
    // has been clicked, so it is counted separately rather than as a failure.
    var missingOptional = entries.filter(function (e) {
      return !e.required && !e.found && !e.postInteraction;
    });

    var pageCtx = {};
    Object.keys(ctx || {}).forEach(function (k) { pageCtx[k] = ctx[k]; });
    pageCtx.flowCfg = cfg;

    // The page verdict is computed BEFORE the sweep, because it decides whether
    // the sweep runs at all. Suppressing only the PRINTING was not enough: the
    // DOM walk still happened and the signatures still rode in the report
    // object, so a report built on a marketplace home page carried a
    // description of that home page's controls that nothing ever asked for.
    var page = pageCheck((ctx && ctx.platformCfg) || cfg, flow, pageCtx);

    // Candidates are collected ONLY for the kinds a required selector missed.
    // A clean flow adds nothing to the report, and a flow blocked on one text
    // input does not list every button on the page.
    // US-2485 round four: DEEP mode widens the sweep to every miss, not just
    // the required ones.
    //
    // The sweep normally fires on a missing REQUIRED selector, and a control
    // that only exists after a click is by definition not required — so the
    // two selectors we most needed described were the two the report could
    // never describe. A seller sat on Mercari's open menu looking at its Delete
    // button, and on a Poshmark closet with the "Shared" banner still on
    // screen, and both reports came back saying only "missing, as expected".
    //
    // It is opt-in because the default reading is right: on an untouched page
    // those controls SHOULD be missing, and sweeping for them every time would
    // dress a clean report up as a broken one. The checkbox is the seller
    // saying the click already happened.
    var deep = Boolean(ctx && ctx.deep);
    var wanted = deep
      ? entries.filter(function (e) { return !e.found; })
      : missingRequired;

    var candidates = null;
    var collect = ctx && ctx.candidates;
    // `!== false` and not a truthiness check: a null verdict means "cannot
    // tell", and the sweep is what makes an unknown page worth reporting at all.
    // Only a page the report has positively called WRONG is skipped.
    if (typeof collect === "function" && wanted.length > 0 && page.onExpectedPage !== false) {
      candidates = {};
      var kinds = wanted.map(function (e) { return candidateKind(e.selector); });

      // US-2485 round three: a `button` sweep is not enough for a MENU.
      //
      // Every delist report came back with a dozen header buttons and no
      // listing control, and the reason is that the control we are hunting is
      // routinely NOT a <button> — Poshmark's is `[data-et-name=...]`, and an
      // overflow menu is as likely to be an <a> or a plain <div>. So a missing
      // button-ish selector also asks for `testids`: the distinct test
      // attributes present anywhere on the page, whatever element carries them.
      // That is the one list that reliably contains the answer, and it is the
      // most compact form of it.
      if (kinds.indexOf("button") !== -1 || kinds.indexOf("any") !== -1) {
        kinds.push("testids");
      }

      kinds.forEach(function (kind) {
        if (candidates[kind]) return;
        try {
          var found = collect(kind);
          candidates[kind] = Array.isArray(found) ? found.map(String) : [];
        } catch (_err) {
          candidates[kind] = [];
        }
      });
    }

    return {
      flow: flow,
      enabled: Boolean(cfg && cfg.enabled),
      version: (cfg && cfg.version) || null,
      lastVerified: (cfg && cfg.lastVerified) || null,
      entries: entries,
      ok: missingRequired.length === 0,
      missingRequired: missingRequired.map(function (e) { return e.key; }),
      missingOptional: missingOptional.map(function (e) { return e.key; }),
      // The URL patterns live on the PLATFORM config, not the flow config —
      // `delist` and `engage` are handed their own sub-object — so the platform
      // config rides along in ctx rather than being guessed at from the flow.
      page: page,
      candidates: candidates,
      deep: deep,
    };
  }

  /**
   * Probe every flow a platform declares.
   *
   * `host` is taken from the caller rather than read here, and the caller is
   * expected to pass location.host — NOT location.href. See the header.
   */
  function buildProbeReport(selectors, platform, matches, ctx) {
    var cfg = selectors && selectors[platform];
    if (!cfg) {
      return {
        platform: platform,
        host: (ctx && ctx.host) || null,
        error: "no selectors are bundled for " + platform,
        flows: [],
      };
    }
    var flowCtx = {};
    Object.keys(ctx || {}).forEach(function (k) { flowCtx[k] = ctx[k]; });
    flowCtx.platformCfg = cfg;

    var flows = [probeFlow(cfg, "list", matches, flowCtx)];
    if (cfg.delist) flows.push(probeFlow(cfg.delist, "delist", matches, flowCtx));
    if (cfg.engage) flows.push(probeFlow(cfg.engage, "engage", matches, flowCtx));
    return {
      platform: platform,
      host: (ctx && ctx.host) || null,
      checkedAt: (ctx && ctx.at) || null,
      // US-2487: what appeared while the watcher was armed. Reported once for
      // the page rather than per flow — a toast belongs to the page, and the
      // seller who armed the watcher knows which action they took.
      appeared: (ctx && Array.isArray(ctx.appeared)) ? ctx.appeared.slice(0) : [],
      flows: flows,
    };
  }

  /**
   * US-2698: the same one-click check, for the SOLD-SYNC reads.
   *
   * Deliberately its own entry point rather than another branch inside
   * buildProbeReport. The two describe different pages and are verified in
   * different sittings: the lister flows want the sell form and one of your own
   * live listings, sync wants your Sold page and your closet. Folding them
   * together would produce one report where half the flows are always "wrong
   * page", which is exactly the confusion US-2485 was filed to remove.
   *
   * Same privacy contract, inherited by reusing probeFlow: the report carries
   * the host, the selector version and per-selector verdicts, and no page
   * content. On the Sold page that matters more than anywhere else in the
   * extension, because the page it is describing has the buyer's address on it.
   */
  function buildSyncProbeReport(syncSelectors, platform, matches, ctx) {
    var cfg = syncSelectors && syncSelectors[platform];
    if (!cfg) {
      return {
        platform: platform,
        kind: "sync",
        host: (ctx && ctx.host) || null,
        error: "no sold-sync selectors are bundled for " + platform,
        flows: [],
      };
    }
    var flowCtx = {};
    Object.keys(ctx || {}).forEach(function (k) { flowCtx[k] = ctx[k]; });
    flowCtx.platformCfg = cfg;

    var flows = [];
    if (cfg.sold) flows.push(probeFlow(cfg.sold, "sold", matches, flowCtx));
    if (cfg.closet) flows.push(probeFlow(cfg.closet, "closet", matches, flowCtx));
    return {
      platform: platform,
      kind: "sync",
      host: (ctx && ctx.host) || null,
      checkedAt: (ctx && ctx.at) || null,
      // Stated on the report because it is the question the reader has: this
      // adapter does not run until somebody sets lastVerified, and a clean
      // report is what earns that.
      enabled: cfg.enabled === true,
      version: cfg.version || null,
      lastVerified: cfg.lastVerified || null,
      appeared: [],
      flows: flows,
    };
  }

  /** Plain-text report, sized to be pasted into a chat message. */
  function formatProbeReport(report) {
    var lines = [];
    lines.push("GradeThread selector check — " + report.platform +
      (report.host ? " (" + report.host + ")" : ""));
    if (report.checkedAt) lines.push("checked: " + report.checkedAt);
    if (report.error) {
      lines.push("ERROR: " + report.error);
      return lines.join("\n");
    }

    var wrongPage = false;

    report.flows.forEach(function (f) {
      lines.push("");
      lines.push("[" + f.flow + "]  selector v" + f.version +
        "  enabled=" + f.enabled +
        "  lastVerified=" + (f.lastVerified || "never") +
        // Stated on EVERY flow, not only where it changed the output. The deep
        // marker used to appear solely in the candidates header, so a run with
        // the box unticked looked identical to one with it ticked that had
        // nothing to add — and three rounds were spent asking for a report
        // that had, in fact, already been sent without the box.
        "  deep=" + (f.deep ? "on" : "off"));

      // Stated FIRST, because it changes how every line under it reads.
      var page = f.page || {};
      if (page.onExpectedPage === true) {
        lines.push("  page: yes, this is " + page.what);
      } else if (page.onExpectedPage === false) {
        wrongPage = true;
        lines.push("  page: NO — this is not " + page.what + ", so the misses below");
        lines.push("        prove nothing. Open " + (page.open || page.what) + " and re-run.");
      }

      f.entries.forEach(function (e) {
        var mark = e.found ? "ok  " : (e.required ? "MISS" : "--  ");
        var tags = [];
        if (e.required) tags.push("required");
        if (e.postInteraction) tags.push("appears after a click");
        if (e.invalid) tags.push("INVALID SELECTOR");
        lines.push("  " + mark + " " + e.key +
          (tags.length ? "  (" + tags.join(", ") + ")" : ""));
        if (!e.found) lines.push("       " + e.selector);
      });
      lines.push("  => " + (f.ok
        ? "every required selector resolves"
        : "BLOCKED, missing required: " + f.missingRequired.join(", ")));

      // Only worth printing when the seller is on the right page — otherwise
      // these are the controls of some other page entirely.
      if (f.candidates && page.onExpectedPage !== false) {
        var kinds = Object.keys(f.candidates);
        var any = kinds.some(function (k) { return f.candidates[k].length > 0; });
        if (any) {
          lines.push(f.deep
            ? "  what IS on the page RIGHT NOW, menu/dialog included (attributes only):"
            : "  what IS on the page (attribute signatures, no typed values):");
          kinds.forEach(function (k) {
            var list = f.candidates[k];
            if (!list.length) return;
            lines.push("    [" + k + "]");
            list.forEach(function (sig) { lines.push("      " + sig); });
          });
        }
      }
    });

    if (report.appeared && report.appeared.length) {
      lines.push("");
      lines.push("APPEARED while the watcher was armed (attributes only, no text):");
      report.appeared.forEach(function (sig) { lines.push("  " + sig); });
      lines.push("  ↑ a success toast lives in here. It is the one control that");
      lines.push("    cannot be found by looking at a page, because it is gone");
      lines.push("    before anyone can look.");
    }

    lines.push("");
    lines.push("Controls marked \"appears after a click\" are expected to be");
    lines.push("missing on a page where nothing has been opened yet.");
    if (wrongPage) {
      lines.push("At least one flow was checked on the wrong page — see \"page: NO\" above.");
    }
    lines.push("No listing content is included: element attributes and button");
    lines.push("labels only, never a field's value.");
    return lines.join("\n");
  }

  /** True when every flow's required selectors resolve. */
  function reportIsClean(report) {
    if (!report || report.error) return false;
    return report.flows.length > 0 && report.flows.every(function (f) { return f.ok; });
  }

  root.GT_SELECTOR_PROBE = {
    selectorsFor: selectorsFor,
    candidateKind: candidateKind,
    pageCheck: pageCheck,
    probeFlow: probeFlow,
    buildProbeReport: buildProbeReport,
    buildSyncProbeReport: buildSyncProbeReport,
    formatProbeReport: formatProbeReport,
    reportIsClean: reportIsClean,
    POST_INTERACTION: POST_INTERACTION,
  };
})(typeof self !== "undefined" ? self : globalThis);
