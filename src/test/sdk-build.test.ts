// The SDK builds, and plain Node can import it the way a customer would.
//
// package.json used to point main, types and exports at ./src/index.ts, so
// `import "@gradethread/sdk"` failed in Node even had it been published. This
// compiles the package with its own tsconfig, lays it out as
// node_modules/@gradethread/sdk with the real package.json, and imports it by
// NAME from a child `node` process, so the exports map is what resolves it.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SDK = resolve(ROOT, "sdk/gradethread-js");
const TSC = resolve(ROOT, "node_modules/typescript/bin/tsc");
const pkg = JSON.parse(readFileSync(join(SDK, "package.json"), "utf8"));

const work = mkdtempSync(join(tmpdir(), "gt-sdk-build-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("@gradethread/sdk package", () => {
  it("points main, types and exports at built files, and ships only dist", () => {
    expect(pkg.main).toBe("./dist/index.js");
    expect(pkg.types).toBe("./dist/index.d.ts");
    expect(pkg.exports["."]).toEqual({ types: "./dist/index.d.ts", import: "./dist/index.js" });
    expect(pkg.files).toContain("dist");
    expect(pkg.files).not.toContain("src");
  });

  // .github/workflows/sdk-publish.yml publishes a scoped package with
  // provenance; a scoped package defaults to private and the first publish
  // fails with 402 without access: public.
  it("publishes publicly with provenance, from the repo it names", () => {
    expect(pkg.name).toBe("@gradethread/sdk");
    expect(pkg.publishConfig).toMatchObject({ access: "public", provenance: true });
    expect(pkg.repository.url).toContain("github.com/dj-pearson/GradeThread");
    expect(pkg.repository.directory).toBe("sdk/gradethread-js");
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  it("compiles, and Node imports it by name", { timeout: 60_000 }, () => {
    const installed = join(work, "node_modules/@gradethread/sdk");
    mkdirSync(installed, { recursive: true });
    cpSync(join(SDK, "package.json"), join(installed, "package.json"));
    execFileSync(process.execPath, [TSC, "-p", join(SDK, "tsconfig.json"), "--outDir", join(installed, "dist")], {
      stdio: "pipe",
    });
    expect(existsSync(join(installed, pkg.main))).toBe(true);
    expect(existsSync(join(installed, pkg.types))).toBe(true);

    const probe = [
      'const m = await import("@gradethread/sdk");',
      'const gt = new m.GradeThread({ apiKey: "k", fetch: async () => new Response("{}") });',
      "console.log(JSON.stringify({",
      "  exports: Object.keys(m).sort(),",
      "  groups: Object.keys(gt).filter((k) => typeof gt[k] === 'object' && k !== 'fetchImpl').sort(),",
      "}));",
    ].join("\n");
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
      cwd: work,
      encoding: "utf8",
    });
    const { exports, groups } = JSON.parse(out) as { exports: string[]; groups: string[] };
    expect(exports).toEqual(
      expect.arrayContaining(["GradeThread", "GradeThreadError", "verifyWebhook", "DEFAULT_BASE_URL", "default"]),
    );
    expect(groups).toEqual(
      expect.arrayContaining(["grades", "items", "listings", "sales", "usage", "priceGuide", "sandbox", "webhook"]),
    );
  });

  // sdk/gradethread-js/test/*.test.mjs is what `npm test` runs in the package,
  // and sdk-publish.yml runs it before every publish. Running it here as well,
  // against the dist compiled above, means a PR that breaks it goes red in
  // ordinary CI instead of on release day.
  it("passes its own node --test suite against the built dist", { timeout: 60_000 }, () => {
    const installed = join(work, "node_modules/@gradethread/sdk");
    expect(existsSync(join(installed, pkg.main)), "the compile test above must run first").toBe(true);
    cpSync(join(SDK, "test"), join(installed, "test"), { recursive: true });
    const out = execFileSync(process.execPath, ["--test", "--test-reporter=tap"], {
      cwd: installed,
      encoding: "utf8",
    });
    expect(out).toMatch(/^# fail 0$/m);
    expect(out).toMatch(/^# pass [1-9]\d*$/m);
  });
});
