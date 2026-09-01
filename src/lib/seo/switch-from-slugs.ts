// The switch-from SLUGS, and nothing else (US-9209). Same reason as
// competitor-alternative-slugs.ts: the router needs the paths to register them
// ahead of /reselling/:slug, and must not pull the prose into the eager chunk.

export const SWITCH_FROM_SLUGS = ["vendoo", "list-perfectly"] as const;

export type SwitchFromSlug = (typeof SWITCH_FROM_SLUGS)[number];

/** The public path for a switch-from page. */
export function switchFromPath(slug: string): string {
  return `/reselling/switch-from-${slug}`;
}
