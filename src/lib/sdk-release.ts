// One switch for "is @gradethread/sdk on npm yet".
//
// Two places tell a customer how to install the SDK: the /developers page and
// sdk/gradethread-js/README.md (which becomes the package's npm page). Both read
// from here, so flipping them is one edit plus one command:
//
//   1. set SDK_PUBLISHED = true below
//   2. node scripts/sync-sdk-readme.mjs   (rewrites the README install block)
//
// Do both in the commit you tag for the first release, so the npm page is
// right from day one; the order around pushing main is in
// vault/10-ops/publishing-the-sdk.md.
//
// src/test/developers-sdk-install.test.tsx fails if the README block does not
// match sdkReadmeInstallBlock(SDK_PUBLISHED), so step 2 cannot be forgotten.
//
// Keep this file free of imports and non-erasable TypeScript: the sync script
// loads it with plain Node type stripping.

/** True once @gradethread/sdk is on npm (see the runbook for the order). */
export const SDK_PUBLISHED = false;

export const SDK_PACKAGE_NAME = "@gradethread/sdk";
export const SDK_INSTALL_COMMAND = `npm install ${SDK_PACKAGE_NAME}`;
export const SDK_SUPPORT_MAILTO = "mailto:support@gradethread.com?subject=JavaScript%20SDK%20access";

export const SDK_README_START = "<!-- sdk-install:start (generated from src/lib/sdk-release.ts) -->";
export const SDK_README_END = "<!-- sdk-install:end -->";

/** The README's install block body, between the two markers. */
export function sdkReadmeInstallBlock(published: boolean = SDK_PUBLISHED): string {
  if (published) {
    return ["```sh", SDK_INSTALL_COMMAND, "```"].join("\n");
  }
  return [
    "The SDK is not published to npm yet, and the GradeThread repository is",
    "private, so there is no install command that works for an outside customer",
    "today. Until it is published, call the HTTP API directly: the endpoints,",
    "scopes, auth header and request examples are on the developers page at",
    "<https://gradethread.com/developers>. Email",
    `[support@gradethread.com](${SDK_SUPPORT_MAILTO})`,
    "and we'll let you know when the package is available.",
    "",
    `Once it is published this becomes \`${SDK_INSTALL_COMMAND}\`, and the`,
    "examples below work unchanged.",
  ].join("\n");
}

/** Replace the marked block in README text. Throws if the markers are missing. */
export function withSdkReadmeInstallBlock(readme: string, published: boolean = SDK_PUBLISHED): string {
  const start = readme.indexOf(SDK_README_START);
  const end = readme.indexOf(SDK_README_END);
  if (start < 0 || end < start) {
    throw new Error("sdk/gradethread-js/README.md is missing the sdk-install markers");
  }
  return (
    readme.slice(0, start + SDK_README_START.length) +
    "\n" +
    sdkReadmeInstallBlock(published) +
    "\n" +
    readme.slice(end)
  );
}
