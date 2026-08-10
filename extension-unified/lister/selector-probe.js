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
// Pure by construction: `matches` is injected, so this file has no DOM, no
// chrome.* and no network, and the tests exercise every branch without a
// browser.

(function (root) {
  "use strict";

  /** Selector keys that only exist AFTER an interaction, per flow. */
  var POST_INTERACTION = {
    delist: ["remove", "confirm"],
    engage: ["shareToFollowers", "offerPriceInput", "offerSubmit", "actionConfirmed"],
    list: [],
  };

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
    } else {
      Object.keys(cfg || {}).forEach(function (k) {
        if (typeof cfg[k] === "string" && k !== "version" && k !== "lastVerified" &&
            k !== "closetUrlPattern") {
          push(k, cfg[k]);
        }
      });
    }
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
  function probeFlow(cfg, flow, matches) {
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

    return {
      flow: flow,
      enabled: Boolean(cfg && cfg.enabled),
      version: (cfg && cfg.version) || null,
      lastVerified: (cfg && cfg.lastVerified) || null,
      entries: entries,
      ok: missingRequired.length === 0,
      missingRequired: missingRequired.map(function (e) { return e.key; }),
      missingOptional: missingOptional.map(function (e) { return e.key; }),
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
    var flows = [probeFlow(cfg, "list", matches)];
    if (cfg.delist) flows.push(probeFlow(cfg.delist, "delist", matches));
    if (cfg.engage) flows.push(probeFlow(cfg.engage, "engage", matches));
    return {
      platform: platform,
      host: (ctx && ctx.host) || null,
      checkedAt: (ctx && ctx.at) || null,
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

    report.flows.forEach(function (f) {
      lines.push("");
      lines.push("[" + f.flow + "]  selector v" + f.version +
        "  enabled=" + f.enabled +
        "  lastVerified=" + (f.lastVerified || "never"));
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
    });

    lines.push("");
    lines.push("Controls marked \"appears after a click\" are expected to be");
    lines.push("missing on a page where nothing has been opened yet.");
    lines.push("No page content is included in this report.");
    return lines.join("\n");
  }

  /** True when every flow's required selectors resolve. */
  function reportIsClean(report) {
    if (!report || report.error) return false;
    return report.flows.length > 0 && report.flows.every(function (f) { return f.ok; });
  }

  root.GT_SELECTOR_PROBE = {
    selectorsFor: selectorsFor,
    probeFlow: probeFlow,
    buildProbeReport: buildProbeReport,
    formatProbeReport: formatProbeReport,
    reportIsClean: reportIsClean,
    POST_INTERACTION: POST_INTERACTION,
  };
})(typeof self !== "undefined" ? self : globalThis);
