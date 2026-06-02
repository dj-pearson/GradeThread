// Head bootstrap — externalized from index.html so the SPA can ship an
// ENFORCING Content-Security-Policy (US-264) without 'unsafe-inline' in
// script-src. Same-origin, so it's covered by `script-src 'self'`. Loaded as a
// blocking <script> in <head> (it's tiny) so the Consent Mode defaults are set
// before gtag.js processes the dataLayer.
(function () {
  // --- Google Consent Mode v2: everything denied until the cookie banner
  //     opts in (GDPR/CCPA). The banner calls
  //     gtag('consent','update',{analytics_storage:'granted'}) on accept. ---
  window.dataLayer = window.dataLayer || [];
  function gtag() {
    window.dataLayer.push(arguments);
  }
  window.gtag = gtag;
  gtag("consent", "default", {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: "denied",
    wait_for_update: 500,
  });
  gtag("js", new Date());
  gtag("config", "G-CMDWCFC275");

  // --- Inter font, non-render-blocking, CSP-safe. Previously an inline
  //     `onload="this.rel='stylesheet'"` on a preload <link> (blocked by a
  //     strict script-src). Injecting the stylesheet <link> here is equivalent
  //     and needs no inline handler; the hero LCP still paints in the system
  //     fallback and swaps to Inter on load (display=swap). preconnects stay in
  //     index.html; the <noscript> there covers no-JS visitors. ---
  var link = document.createElement("link");
  link.rel = "stylesheet";
  link.href =
    "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap";
  document.head.appendChild(link);
})();
