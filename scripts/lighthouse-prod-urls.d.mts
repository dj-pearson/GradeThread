// Types for scripts/lighthouse-prod-urls.mjs, so src/test/lighthouse-config.test.ts
// imports the real selection logic without TS7016.

export const DEFAULT_BASE: string;
export function locs(xml: string | null | undefined): string[];
export function pickProdUrls(
  sitemaps: {
    condition: string | null;
    blog: string | null;
    certs: string | null;
  },
  base?: string,
): string[];
export function lhUrlKey(u: string): string;
export interface LhManifestRun {
  url: string;
  isRepresentativeRun?: boolean;
  summary?: Record<string, number>;
}
export function matchManifest(
  wanted: string[],
  manifest: LhManifestRun[] | unknown,
  links?: Record<string, string>,
): Array<{
  url: string;
  measuredUrl: string | null;
  summary: Record<string, number> | null;
  report: string | null;
}>;
