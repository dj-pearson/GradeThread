import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import path from "path";
import { writeFileSync } from "fs";
import { PUBLIC_ROUTES, SITE_URL, lastModifiedFor } from "./src/lib/seo/public-routes";

// Source-map upload only runs on builds that carry a Sentry auth token (CI).
// Local/tokenless builds skip it and emit no source maps, so nothing leaks.
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;
const uploadSourcemaps = Boolean(sentryAuthToken);

// Emits dist/seo-manifest.json from the indexable-route registry (US-291) so
// the sitemap Pages Function and the deploy-time IndexNow submitter share a
// build-stable source of truth for static public URLs.
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
    seoManifestPlugin(),
    VitePWA({
      registerType: "autoUpdate",
      // The service worker is registered explicitly from the FlipDesk intake
      // page (see src/lib/pwa.ts), not auto-injected app-wide.
      injectRegister: null,
      // The web app manifest is the static file at public/manifest.webmanifest.
      manifest: false,
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
        navigateFallback: "/index.html",
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
