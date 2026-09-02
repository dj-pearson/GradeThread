// GradeThread unified extension — first-run onboarding links (US-1753 AC3).
//
// The browser opens this page exactly once, on install (background.js
// onInstalled, reason "install"). That makes its outbound links the INSTALL half
// of the funnel — the only click that can be joined back to a fresh install
// without ever sending an install identifier to the server.
//
// So the links are built here rather than hard-coded in the HTML: they carry
// utm_campaign=install when the background opened the page (?first_run=1), and
// the ordinary onboarding campaign when someone reopens the page later. An
// inline <script> would be blocked by the MV3 page CSP, hence a file.

(function () {
  const ATTR = self.GT_ATTRIBUTION;
  // US-3055: honour the theme preference on the welcome page too.
  try { void self.GT_THEME.init(globalThis.browser || globalThis.chrome, document); } catch (_e) { /* no storage: OS theme */ }

  // ?first_run=1 is set only by the install-triggered open. Reopening this page
  // from history is a real visit, but it is not an install, and calling it one
  // would overstate the install funnel every time.
  const firstRun = new URLSearchParams(location.search).get("first_run") === "1";
  const campaign = firstRun ? ATTR.INSTALL_CAMPAIGN : "onboarding";

  const LINKS = [
    { id: "ctaLink", path: "/connect-extension", medium: "onboarding" },
    { id: "privacyLink", path: "/privacy", medium: "onboarding" },
  ];

  for (const l of LINKS) {
    const el = document.getElementById(l.id);
    if (el) el.href = ATTR.siteUrl(l.path, l.medium, { campaign: campaign });
  }

  // US-1757 (AC2): count the click-through, if — and only if — the shopper has
  // opted into usage counts (the background checks; nothing is sent otherwise).
  // This page is the top of the install funnel, so a click from here is the
  // single most load-bearing number in it.
  const ext = globalThis.browser || globalThis.chrome;
  self.GT_USAGE.trackSiteClicks(document, "onboarding", {
    isSiteUrl: ATTR.isSiteUrl,
    send: (event, surface) => {
      try {
        Promise.resolve(
          ext.runtime.sendMessage({ type: "GT_CC_USAGE", event, surface }),
        ).catch(() => {});
      } catch (_e) { /* worker asleep — the click still happens */ }
    },
  });
})();
