// US-2777: the seller's country domain, for the marketplaces that have more
// than one.
//
// THE DEFECT THIS CLOSES. US-2479 built locale support end to end -
// `ListerPayload.locale`, `newListingUrlForLocale`, 22 bundled Vinted domains,
// a fail-loud message naming the covered ones - and no caller ever set the
// field. `newListingUrlForLocale` returns the platform default when the locale
// is absent (lister-guard.js:97), so a French seller got vinted.com and saw a
// working flow that filled a form on the wrong country's site. Silent, not an
// error. The fail-loud branch only runs when a locale IS supplied and is not
// covered, which was the one case that could not happen.
//
// WHY THE LIST IS DUPLICATED HERE. The authority is
// `extension-unified/lister/selectors.js`, which the extension bundles and the
// SPA cannot import (it is a UMD file that assigns to `self`). So the SPA
// carries its own copy for the picker, and
// `src/test/lister-locale-producers.test.ts` fails if the two ever disagree -
// including if a NEW platform grows a `locales` map here or there. A copy with
// a guard is a copy; a copy without one is a fork.

/** Platforms whose `newListingUrl` depends on the seller's country. */
export const MULTI_DOMAIN_PLATFORMS = ["vinted"] as const;

export type MultiDomainPlatform = (typeof MULTI_DOMAIN_PLATFORMS)[number];

/**
 * The locale keys each multi-domain platform covers, in the order the picker
 * shows them: the default first, then alphabetical.
 *
 * These are HOSTS used as keys, never URLs. The extension resolves a key
 * against its own bundled map to get somewhere to navigate — that is the
 * US-1876 rule, and it is why a value that travels through the database and
 * three clients is safe here.
 */
export const LISTER_LOCALES: Record<MultiDomainPlatform, readonly string[]> = {
  vinted: [
    "vinted.com",
    "vinted.at",
    "vinted.be",
    "vinted.co.uk",
    "vinted.cz",
    "vinted.de",
    "vinted.dk",
    "vinted.es",
    "vinted.fi",
    "vinted.fr",
    "vinted.gr",
    "vinted.hr",
    "vinted.hu",
    "vinted.it",
    "vinted.lt",
    "vinted.lu",
    "vinted.nl",
    "vinted.pl",
    "vinted.pt",
    "vinted.ro",
    "vinted.se",
    "vinted.sk",
  ],
};

/**
 * The locale a platform falls back to when the seller has chosen none.
 *
 * Kept as data rather than "the first entry" so the picker can label it and so
 * the guard test can pin it against `newListingUrl` in the bundled config. The
 * bundled comment states why it is vinted.com and not a larger European
 * market: defaulting to a European domain would silently send US sellers
 * somewhere their account does not exist.
 */
export const LISTER_LOCALE_DEFAULT: Record<MultiDomainPlatform, string> = {
  vinted: "vinted.com",
};

export function isMultiDomainPlatform(
  platform: string,
): platform is MultiDomainPlatform {
  return (MULTI_DOMAIN_PLATFORMS as readonly string[]).includes(platform);
}

/** What the `lister_locales` column holds: platform -> locale key. */
export type ListerLocaleMap = Partial<Record<string, string>>;

/**
 * The seller's locale for one platform, or `undefined` for "use the default".
 *
 * Returns undefined rather than the default key on purpose. An absent locale
 * and an explicit default are the same navigation target, but only the absent
 * one should be omitted from the payload — a payload that names no locale is
 * exactly what every seller sends today, so leaving it out is the change that
 * does nothing for anyone who has not chosen.
 *
 * DELIBERATELY NOT FILTERED against LISTER_LOCALES. The extension's own bundled
 * map is the authority on which domains it can open, and it already fails loud
 * on one it does not cover — that is the US-2479 design. Filtering here would
 * turn "we cannot open vinted.xx" into a silent fall back to vinted.com, which
 * is the precise failure this story exists to end. It would also make this path
 * disagree with the edge's queued stamp, which has no such list; two paths
 * behaving differently is how the locale went unset for months.
 */
export function localeForPlatform(
  stored: ListerLocaleMap | null | undefined,
  platform: string,
): string | undefined {
  if (!stored || !isMultiDomainPlatform(platform)) return undefined;
  const value = stored[platform];
  if (typeof value !== "string" || value === "") return undefined;
  return value;
}

/**
 * Normalise a picked value for storage: drop the platform's key when the
 * seller picks the default.
 *
 * Storing "vinted.com" and storing nothing mean the same thing, and keeping one
 * spelling of "no preference" is what lets `localeForPlatform` stay a lookup
 * rather than a comparison.
 */
export function normalizeLocaleSelection(
  stored: ListerLocaleMap | null | undefined,
  platform: MultiDomainPlatform,
  picked: string,
): ListerLocaleMap {
  const next: ListerLocaleMap = { ...(stored ?? {}) };
  if (picked === LISTER_LOCALE_DEFAULT[platform] || !LISTER_LOCALES[platform].includes(picked)) {
    delete next[platform];
  } else {
    next[platform] = picked;
  }
  return next;
}

/**
 * The value the picker's Select should show, and the options it should offer.
 *
 * A stored key that is no longer covered has to stay VISIBLE. Silently showing
 * the default instead would tell a seller they are on vinted.com while their
 * saved key still ships in every payload — the UI and the wire disagreeing,
 * which is worse than either being wrong on its own. It is offered as an extra
 * option so the Select stays controlled and the seller can change it.
 */
export function localeOptions(
  stored: ListerLocaleMap | null | undefined,
  platform: MultiDomainPlatform,
): { value: string; options: readonly string[]; strayValue: string | null } {
  const covered = LISTER_LOCALES[platform];
  const saved = localeForPlatform(stored, platform);
  if (saved && !covered.includes(saved)) {
    return { value: saved, options: [saved, ...covered], strayValue: saved };
  }
  return {
    value: saved ?? LISTER_LOCALE_DEFAULT[platform],
    options: covered,
    strayValue: null,
  };
}
