// GradeThread unified extension — page↔background bridge (US-1882)
//
// The seller flows (and the sign-in token handoff) are driven by the
// gradethread.com SaaS talking TO the extension. On Chromium that uses
// `externally_connectable` (the page calls chrome.runtime.sendMessage(extId,…)) —
// but Firefox does not support externally_connectable at all. This content script
// (injected only on gradethread.com) provides the standard cross-browser
// alternative: it relays `window.postMessage` envelopes from the page to the
// background via internal runtime messaging, and relays the response back.
//
// It ALSO drops a DOM marker (data-gt-ext-bridge) so the page can synchronously
// detect that our extension is installed — the same signal that gates the
// "Send to extension" UI (src/lib/lister-extension.ts). It runs in both browsers;
// the page prefers externally_connectable on Chromium and this bridge on Firefox.
//
// SECURITY: this only relays — the background re-checks the sender origin
// (GT_LISTER_GUARD.isOriginAllowed → gradethread.com) and gates seller actions on
// the account entitlement, exactly as it does for externally_connectable. Only
// same-window messages with our envelope are forwarded.

(function () {
  "use strict";
  // Firefox: promise-based `browser`. Chrome: `chrome` (MV3 promises). Alias so the
  // one relay call works in both.
  var api = globalThis.browser || globalThis.chrome;
  if (!api || !api.runtime || !api.runtime.sendMessage) return;

  // Synchronous install marker for the page (set at document_start).
  try {
    document.documentElement.setAttribute("data-gt-ext-bridge", "1");
  } catch (_e) { /* no documentElement yet — extremely early; ignore */ }

  // US-1874: background → page PUSH relay.
  //
  // A Lister job outlives the request that started it: Chrome can kill the MV3
  // worker while the marketplace tab is still loading, which takes the sendResponse
  // port with it. The background therefore reports a finished/failed/late job by
  // messaging the ORIGINATING gradethread.com tab instead of replying on the
  // (possibly dead) port. This relays that push to the page, where the Lister
  // client resolves the pending promise by jobId.
  //
  // SECURITY: only OUR extension's background can deliver an internal runtime
  // message here, and we post to the page with an explicit origin. We forward only
  // the known push type — never arbitrary background traffic.
  if (api.runtime.onMessage && api.runtime.onMessage.addListener) {
    api.runtime.onMessage.addListener(function (msg) {
      // US-1877 (AC1): GT_LISTER_LISTED arrives LATER than the job result — the
      // seller submitted the form minutes after the fill and the marketplace
      // navigated to the live listing. Relayed the same way; the page routes it by
      // type rather than resolving the (long-settled) job promise.
      if (!msg || (msg.type !== "GT_LISTER_JOB_UPDATE" && msg.type !== "GT_LISTER_LISTED")) {
        return;
      }
      try {
        window.postMessage(
          {
            __gtExtPush: true,
            type: msg.type,
            jobId: msg.jobId,
            clientRef: msg.clientRef,
            result: msg.result,
            // US-1877: the LISTED payload.
            platform: msg.platform,
            itemId: msg.itemId,
            listingUrl: msg.listingUrl,
          },
          window.location.origin,
        );
      } catch (_e) { /* page gone */ }
    });
  }

  window.addEventListener("message", function (event) {
    // Only same-window page messages carrying our request envelope.
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.__gtExtReq !== true || typeof data.id !== "string" || !data.message) return;

    var replied = false;
    var reply = function (response) {
      if (replied) return;
      replied = true;
      try {
        window.postMessage({ __gtExtRes: true, id: data.id, response: response }, event.origin);
      } catch (_e) { /* target window gone */ }
    };

    try {
      // Chrome: pass a callback (returns undefined). Firefox: returns a promise
      // (and may also honor the callback) — the `replied` guard makes the double
      // path safe either way.
      var maybePromise = api.runtime.sendMessage(data.message, function (response) {
        if (api.runtime.lastError) {
          reply({
            ok: false,
            transportError: true,
            error: api.runtime.lastError.message || "Extension error.",
          });
          return;
        }
        reply(
          response == null
            ? { ok: false, transportError: true, error: "No response from the extension." }
            : response,
        );
      });
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(
          function (response) {
            reply(
              response == null
                ? { ok: false, transportError: true, error: "No response from the extension." }
                : response,
            );
          },
          function (err) {
            reply({ ok: false, transportError: true, error: (err && err.message) || String(err) });
          },
        );
      }
    } catch (err) {
      reply({ ok: false, transportError: true, error: (err && err.message) || String(err) });
    }
  });
})();
