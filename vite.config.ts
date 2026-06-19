import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import path from "path";
import { writeFileSync, mkdirSync } from "fs";
import { PUBLIC_ROUTES, SITE_URL, lastModifiedFor } from "./src/lib/seo/public-routes";

// Source-map upload only runs on builds that carry a Sentry auth token (CI).
// Local/tokenless builds skip it and emit no source maps, so nothing leaks.
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;
const uploadSourcemaps = Boolean(sentryAuthToken);

// Emits dist/seo-manifest.json from the indexable-route registry (US-291) so
// the sitemap Pages Function and the deploy-time IndexNow submitter share a
// build-stable source of truth for static public URLs.
// US-417: emit a chunk → module-ids map (outside dist, so it isn't deployed)
// for the bundle-size budget check (scripts/check-bundle-budget.mjs). It lets
// the CI guard prove WHICH npm packages landed in the eager/landing chunks —
// e.g. that radix Dialog/Select/Popover and TipTap stay code-split out of them —
// without grepping minified output. Client build only; the prerender SSR pass
// uses a dev server (serve mode) so this never fires there.
function bundleModulesManifestPlugin(): Plugin {
  return {
    name: "bundle-modules-manifest",
    apply: "build",
    generateBundle(_options, bundle) {
      const chunks: Record<string, { isEntry: boolean; imports: string[]; modules: string[] }> = {};
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== "chunk") continue;
        chunks[fileName] = {
          isEntry: output.isEntry,
          imports: output.imports,
          modules: Object.keys(output.modules).map((m) => m.replace(/\\/g, "/")),
        };
      }
      const outDir = path.resolve(__dirname, "build-meta");
      mkdirSync(outDir, { recursive: true });
      writeFileSync(
        path.resolve(outDir, "bundle-modules.json"),
        JSON.stringify(chunks, null, 2) + "\n",
      );
    },
  };
}

// US-421: every navigation that MUST reach the network/edge to get the correct
// per-route HTML — the prerendered static pages (their own crawlable <head>) and
// the dynamic Pages Functions (blog/cert/og/sitemaps SSR) — rather than the
// service worker's generic /index.html SPA shell. Without this the SW bypasses
// the entire prerender/SSR investment by handing every navigation the cached
// shell. The prerendered-route entries are derived from the SEO registry so new
// marketing/glossary pages are excluded automatically.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NAVIGATE_FALLBACK_DENYLIST: RegExp[] = [
  // API + dynamic, server-rendered Pages Functions (functions/*).
  /^\/api\//,
  /^\/blog(\/|$)/,
  /^\/cert\//,
  /^\/badge\//,
  /^\/slab\//,
  /^\/verified\//,
  /^\/condition-index(\/|$)/,
  /^\/og\//,
  /^\/\.well-known\//,
  /^\/(sitemap.*\.xml|robots\.txt|llms\.txt|rss\.xml|csp-report)$/,
  // Prerendered static routes (marketing, legal, glossary spokes). Each is a
  // real per-route index.html on the edge with its own <head>; the root "/"
  // is intentionally left to the navigateFallback (it IS dist/index.html).
  ...PUBLIC_ROUTES.map((r) => r.path)
    .filter((p) => p !== "/")
    .map((p) => new RegExp(`^${escapeRegExp(p)}/?$`)),
];

function seoManifestPlugin(): Plugin {
  return {
    name: "seo-manifest",
    apply: "build",
    closeBundle() {
      const manifest = {
        siteUrl: SITE_URL,
        generatedAt: new Date().toISOString(),
        // US-429: attach each route's stable content-change date so the sitemap
        // <lastmod> reflects real edits, not the build timestamp.
        routes: PUBLIC_ROUTES.map((r) => ({
          ...r,
          lastModified: lastModifiedFor(r.path),
        })),
      };
      writeFileSync(
        path.resolve(__dirname, "dist/seo-manifest.json"),
        JSON.stringify(manifest, null, 2) + "\n",
      );
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    bundleModulesManifestPlugin(),
    seoManifestPlugin(),
    VitePWA({
      registerType: "autoUpdate",
      // The service worker is registered explicitly from the FlipDesk intake
      // page (see src/lib/pwa.ts), not auto-injected app-wide.
      injectRegister: null,
      // The web app manifest is the static file at public/manifest.webmanifest.
      manifest: false,
      workbox: {
        // US-421: precache assets + ONLY the root shell (dist/index.html), NOT
        // the per-route prerendered shells (dist/<route>/index.html). The bare
        // "index.html" glob matches only the top-level file; "**/*.html" would
        // pull every per-route shell into the precache where the generic
        // navigateFallback could serve them stale. The root shell carries a
        // revision hash, so a new deploy busts any stale shell (with
        // cleanupOutdatedCaches + skipWaiting below).
        globPatterns: ["**/*.{js,css,svg,woff2}", "index.html"],
        navigateFallback: "/index.html",
        // Never serve the SPA shell for API calls, server-rendered Pages
        // Functions (blog/cert/og SSR, sitemaps, robots/llms, RSS), OR the
        // prerendered static pages — every one of those must hit the
        // network/edge to get its own per-route <head> instead of the generic
        // cached index.html. See NAVIGATE_FALLBACK_DENYLIST above.
        navigateFallbackDenylist: NAVIGATE_FALLBACK_DENYLIST,
        // Stale-shell guards (US deploy-safety): purge precaches from previous
        // builds on activate, and have a freshly-deployed SW take control of
        // open tabs immediately instead of waiting for every tab to close.
        // Together with the vite:preloadError reload in main.tsx, a deploy can
        // no longer leave a client stuck on a stale index.html that references
        // chunk hashes the new build removed.
        cleanupOutdatedCaches: true,
        skipWaiting: true,
        clientsClaim: true,
        runtimeCaching: [
          {
            urlPattern: ({ url }) =>
              url.origin === "https://fonts.googleapis.com" ||
              url.origin === "https://fonts.gstatic.com",
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts",
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ request }) => request.destination === "image",
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "flipdesk-images",
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          // US-744: offline viewing of CERTIFICATES + the public passport. These
          // are server-rendered (Pages Functions) and excluded from the SPA
          // navigateFallback, so without this a navigation while offline fails.
          // NetworkFirst keeps the LAST-SEEN render available offline while an
          // online client always gets the fresh edge render (network wins when
          // reachable), so there's no stale-while-online risk.
          {
            urlPattern: ({ url, request }) =>
              request.mode === "navigate" &&
              (/^\/cert\//.test(url.pathname) || /^\/passport\//.test(url.pathname)),
            handler: "NetworkFirst",
            options: {
              cacheName: "gt-public-pages",
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 14 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // US-744: the public certificate payload the SPA cert page fetches
          // (/verify). Read-only + unauthenticated, so it's safe to retain for
          // offline. NetworkFirst → fresh when online, last-seen when offline.
          {
            urlPattern: ({ url }) =>
              /(^|\.)functions\./.test(url.hostname) &&
              url.pathname.startsWith("/api/content/public/certificates/"),
            handler: "NetworkFirst",
            options: {
              cacheName: "gt-public-cert-api",
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          // US-744: a reseller's own SUBMISSION STATUS + grade reports (Supabase
          // REST, authed). NetworkFirst so an online client always reads fresh,
          // and only the signed-in owner's last-seen rows are served offline.
          // The cache is per-browser-profile (this one installed PWA user) and
          // capped at a 1-day TTL, so staleness is bounded. Only 200s are cached.
          {
            urlPattern: ({ url }) =>
              /(^|\.)api\./.test(url.hostname) &&
              /\/rest\/v1\/(submissions|grade_reports)\b/.test(url.pathname),
            handler: "NetworkFirst",
            options: {
              cacheName: "gt-submission-status",
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 120, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [200] },
            },
          },
        ],
      },
    }),
    // Upload source maps to Sentry so production stack traces symbolicate,
    // then delete them from the build output so they aren't served publicly.
    // Must come after the other build plugins.
    ...(uploadSourcemaps
      ? [
          sentryVitePlugin({
            authToken: sentryAuthToken,
            org: process.env.SENTRY_ORG,
            project: process.env.SENTRY_PROJECT,
            sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.map"] },
          }),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  define: {
    // Inject the commit SHA from Cloudflare Pages (CF_PAGES_COMMIT_SHA) or
    // any manually set VITE_RELEASE_SHA at build time. Falls back to 'dev'
    // in local builds where neither is set.
    'import.meta.env.VITE_RELEASE_SHA': JSON.stringify(
      process.env.CF_PAGES_COMMIT_SHA ||
      process.env.VITE_RELEASE_SHA ||
      'dev'
    ),
  },
  build: {
    // 'hidden' emits maps without a //# sourceMappingURL comment, so prod
    // bundles never advertise them; the Sentry plugin uploads then removes
    // them. No token → no maps emitted at all.
    sourcemap: uploadSourcemaps ? "hidden" : false,
    rollupOptions: {
      output: {
        // Split large, stable third-party libs out of the entry chunk so they
        // cache independently of app code and download in parallel. Route-level
        // code (charts, the TipTap blog editor) is already lazy-loaded, so this
        // targets the vendors that otherwise land in the eager index chunk.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id))
            return "vendor-react";
          if (id.includes("@supabase")) return "vendor-supabase";
          if (id.includes("@stripe")) return "vendor-stripe";
          if (id.includes("@sentry")) return "vendor-sentry";
          if (id.includes("posthog-js")) return "vendor-posthog";
          if (id.includes("@tanstack")) return "vendor-query";
          // NOTE: @radix-ui is deliberately NOT grouped. Button pulls
          // @radix-ui/react-slot, and Button renders on the public/landing
          // pages — forcing all of radix into one "vendor-radix" chunk meant
          // ~37KB gz of Dialog/Select/Popover/etc. downloaded on the landing
          // page that never uses them (a PageSpeed "unused JS" hit). Letting
          // Rollup split radix per-route keeps react-slot tiny on public pages
          // and loads the heavy primitives only on the dashboard chunks.
          // Everything else: let Rollup decide so lazily-imported heavy libs
          // (recharts, TipTap) stay in their own route chunks instead of being
          // forced into an eager vendor bundle.
          return undefined;
        },
      },
    },
  },
});
