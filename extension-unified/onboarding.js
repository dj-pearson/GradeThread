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
})();
