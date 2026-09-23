// How to install the SDK, on /developers and in the SDK's own README.
//
// The page's install block used to be a `git clone` of
// github.com/dj-pearson/GradeThread. That repository is private, so the command
// failed for every outside customer, and the README carried the same line after
// the page stopped. Neither may give it again.
//
// Whether either says `npm install @gradethread/sdk` or "not published yet" is
// ONE switch, SDK_PUBLISHED in src/lib/sdk-release.ts. This renders the page
// under both values and checks the README matches the current one, so flipping
// the flag is the whole change and cannot leave one surface behind.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SDK_INSTALL_COMMAND,
  SDK_PUBLISHED,
  SDK_README_END,
  SDK_README_START,
  sdkReadmeInstallBlock,
  withSdkReadmeInstallBlock,
} from "@/lib/sdk-release";

const PAGE = readFileSync(resolve(process.cwd(), "src/pages/marketing/developers.tsx"), "utf8");
const README = readFileSync(resolve(process.cwd(), "sdk/gradethread-js/README.md"), "utf8");

// Code only: the comment explaining the history names the old command.
const CODE = PAGE.replace(/^\s*\/\/.*$/gm, "");

async function renderDevelopers(published: boolean): Promise<string> {
  vi.resetModules();
  vi.doMock("@/lib/sdk-release", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/sdk-release")>()),
    SDK_PUBLISHED: published,
  }));
  const { DevelopersPage } = await import("@/pages/marketing/developers");
  const tree: ReactElement = (
    <MemoryRouter initialEntries={["/developers"]}>
      <DevelopersPage />
    </MemoryRouter>
  );
  return renderToStaticMarkup(tree);
}

afterEach(() => {
  vi.doUnmock("@/lib/sdk-release");
  vi.resetModules();
});

describe("/developers SDK install copy", () => {
  it("does not give a git clone of the private repository", () => {
    expect(CODE).not.toMatch(/git clone/);
    expect(CODE).not.toMatch(/github\.com\/dj-pearson\/GradeThread/);
  });

  it("does not hard-code the install state; SDK_PUBLISHED decides it", () => {
    expect(CODE).toMatch(/SDK_PUBLISHED \?/);
    expect(CODE).not.toContain("npm install @gradethread/sdk");
  });

  it("unpublished: says so, points at support, gives no install command", { timeout: 30_000 }, async () => {
    const html = await renderDevelopers(false);
    expect(html).toMatch(/The SDK is not published yet\./);
    expect(html).toContain("mailto:support@gradethread.com");
    expect(html).not.toContain(SDK_INSTALL_COMMAND);
  });

  it("published: gives npm install and drops the unpublished notice", { timeout: 30_000 }, async () => {
    const html = await renderDevelopers(true);
    expect(html).toContain(SDK_INSTALL_COMMAND);
    expect(html).not.toMatch(/not published yet/);
  });
});

describe("sdk/gradethread-js/README.md install section", () => {
  const install = README.slice(README.indexOf("## Install"), README.indexOf("## Quick start"));

  it("does not give a git clone of the private repository", () => {
    expect(install).not.toMatch(/git clone/);
    expect(install).not.toMatch(/github\.com\/dj-pearson\/GradeThread/);
  });

  it("holds the generated block inside the Install section", () => {
    expect(install).toContain(SDK_README_START);
    expect(install).toContain(SDK_README_END);
  });

  it("matches SDK_PUBLISHED (run node scripts/sync-sdk-readme.mjs after flipping it)", () => {
    expect(README).toBe(withSdkReadmeInstallBlock(README, SDK_PUBLISHED));
  });

  it("unpublished block says so and points at the HTTP API docs and support", () => {
    const block = sdkReadmeInstallBlock(false);
    expect(block).toMatch(/not published to npm yet/);
    expect(block).toContain("https://gradethread.com/developers");
    expect(block).toMatch(/mailto:support@gradethread\.com/);
  });

  it("published block is the npm install command and nothing about being unpublished", () => {
    const block = sdkReadmeInstallBlock(true);
    expect(block).toContain(SDK_INSTALL_COMMAND);
    expect(block).not.toMatch(/not published/);
  });

  it("SDK_INSTALL_COMMAND names the package in sdk/gradethread-js/package.json", () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "sdk/gradethread-js/package.json"), "utf8"));
    expect(SDK_INSTALL_COMMAND).toBe(`npm install ${pkg.name}`);
  });
});
