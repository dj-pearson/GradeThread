import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// US-3108: Universal Links break silently, and they break across four files
// that no compiler reads together.
//
// The chain a password-reset email travels is: Apple fetches the AASA served by
// `functions/.well-known/apple-app-site-association.ts`, matches its appID
// against the installed app's team+bundle id, matches the tapped path against
// that file's `components`, and hands the URL to the app, which only accepts it
// if `AuthStore.isAuthCallback` agrees on the host and path, and only receives
// it at all if `GradeThread.entitlements` claims the domain. A disagreement
// anywhere sends the seller to Safari, signed out, with nothing logged.
//
// Nothing catches that today. The entitlements and the Swift are macOS-only, the
// Pages Function is TypeScript, and `ios/Scripts/check-aasa.sh` is a network
// probe. So this test reads all four as TEXT and asserts they describe the same
// thing.
//
// The failure that prompted it is instructive and is pinned below: check-aasa.sh
// carried a hard-coded team id, `RV6W9F4Y4P`, that appeared nowhere else in the
// repo and did not match production. The guard reported the live file as broken
// for as long as anyone ran it. Neither the app (ios/project.yml takes
// DEVELOPMENT_TEAM from $APPLE_TEAM_ID) nor the AASA (the Pages env var of the
// same name) hard-codes a team id, so a third copy could only ever go stale.

const root = (p: string) => resolve(__dirname, "../..", p);

const AASA_FN = readFileSync(
  root("functions/.well-known/apple-app-site-association.ts"),
  "utf8",
);
const ENTITLEMENTS = readFileSync(
  root("ios/GradeThread/GradeThread.entitlements"),
  "utf8",
);
const PROJECT_YML = readFileSync(root("ios/project.yml"), "utf8");
const CHECK_SH = readFileSync(root("ios/Scripts/check-aasa.sh"), "utf8");
const AUTH_STORE = readFileSync(
  root("ios/GradeThread/Auth/AuthStore.swift"),
  "utf8",
);

/** The bundle id the AASA function falls back to when IOS_BUNDLE_ID is unset. */
function aasaDefaultBundleId(): string {
  const m = /const DEFAULT_BUNDLE_ID = "([^"]+)"/.exec(AASA_FN);
  if (!m?.[1]) throw new Error("DEFAULT_BUNDLE_ID not found in the AASA function");
  return m[1];
}

/** Every path pattern the AASA claims, e.g. "/app/auth-callback*". */
function aasaClaimedPaths(): string[] {
  const block = /const APP_LINK_COMPONENTS = \[([\s\S]*?)\];/.exec(AASA_FN);
  if (!block?.[1]) throw new Error("APP_LINK_COMPONENTS not found");
  const paths = [...block[1].matchAll(/"\/":\s*"([^"]+)"/g)].map((m) => m[1]!);
  if (paths.length === 0) throw new Error("APP_LINK_COMPONENTS parsed empty");
  return paths;
}

/** The domains the entitlements claim, by prefix ("applinks" | "webcredentials"). */
function entitlementDomains(prefix: string): string[] {
  return [...ENTITLEMENTS.matchAll(/<string>([^<]+)<\/string>/g)]
    .map((m) => m[1]!)
    .filter((s) => s.startsWith(`${prefix}:`))
    .map((s) => s.slice(prefix.length + 1));
}

/** The app target's shipping bundle id, first PRODUCT_BUNDLE_IDENTIFIER in project.yml. */
function appBundleId(): string {
  const m = /PRODUCT_BUNDLE_IDENTIFIER:\s*(\S+)/.exec(PROJECT_YML);
  if (!m?.[1]) throw new Error("PRODUCT_BUNDLE_IDENTIFIER not found in project.yml");
  return m[1];
}

/** A claimed pattern like "/app/auth-callback*" matches a concrete path. */
function claims(pattern: string, path: string): boolean {
  return pattern.endsWith("*")
    ? path.startsWith(pattern.slice(0, -1))
    : pattern === path;
}

describe("US-3108: the AASA, the entitlements and the app agree", () => {
  it("the AASA's bundle id is the app target's bundle id", () => {
    expect(aasaDefaultBundleId()).toBe(appBundleId());
  });

  it("the app claims the domain the AASA is served from", () => {
    const url = /^URL="\$\{AASA_URL:-(\S+?)\}"/m.exec(CHECK_SH)?.[1];
    expect(url, "check-aasa.sh must probe a default URL").toBeTruthy();
    const host = new URL(url!).hostname;
    expect(entitlementDomains("applinks")).toContain(host);
    // webcredentials rides the same domain: the AASA advertises both, so the
    // entitlements have to claim both or password autofill silently stops.
    expect(entitlementDomains("webcredentials")).toContain(host);
    expect(AASA_FN).toContain("webcredentials");
  });

  it("the path AuthStore accepts is a path the AASA claims", () => {
    // The Swift guard is the last gate: a URL Apple hands over that AuthStore
    // rejects is a dead link with no log line.
    const swiftPath = /url\.path\.hasPrefix\("([^"]+)"\)/.exec(AUTH_STORE)?.[1];
    expect(swiftPath, "AuthStore.isAuthCallback path prefix not found").toBeTruthy();
    expect(
      aasaClaimedPaths().some((p) => claims(p, swiftPath!)),
      `AASA claims ${aasaClaimedPaths().join(", ")}, AuthStore accepts ${swiftPath}`,
    ).toBe(true);

    const swiftHost = /host == "([^"]+)"/.exec(AUTH_STORE)?.[1];
    expect(entitlementDomains("applinks")).toContain(swiftHost);
  });

  it("the path check-aasa.sh warns about is a path the AASA claims", () => {
    const expected = /^EXPECTED_PATH="([^"]+)"/m.exec(CHECK_SH)?.[1];
    expect(expected).toBeTruthy();
    expect(aasaClaimedPaths().some((p) => claims(p, expected!))).toBe(true);
  });

  it("check-aasa.sh hard-codes no team id", () => {
    // The US-3108 regression itself. A team id is 10 uppercase alphanumerics;
    // the only legitimate sources are $APPLE_TEAM_ID and an explicit argument.
    const literals = [...CHECK_SH.matchAll(/\b([A-Z0-9]{10})\.com\.gradethread/g)]
      .map((m) => m[1]!)
      // The comment block deliberately records both ids to explain the failure,
      // so only lines that could actually set a value count.
      .filter((id) =>
        CHECK_SH.split("\n").some(
          (line) => line.includes(id) && !line.trimStart().startsWith("#"),
        ),
      );
    expect(
      literals,
      "derive the team id from $APPLE_TEAM_ID; a third copy can only go stale",
    ).toEqual([]);
    expect(CHECK_SH).toContain("APPLE_TEAM_ID");
  });

  it("the AASA function fails closed on an unconfigured deploy", () => {
    // Both halves of the appID must fail closed. The team id already did; the
    // bundle id did not until US-2620, and served "<TEAMID>." with HTTP 200.
    expect(AASA_FN).toContain("(env.IOS_BUNDLE_ID ?? \"\").trim() || DEFAULT_BUNDLE_ID");
    expect(AASA_FN).toMatch(/status:\s*503/);
  });
});

// ---------------------------------------------------------------------------
// US-3108, 2026-09-10: the probe itself, RUN rather than read.
//
// The block above reads five files as text, which is the right instrument for
// "do these describe the same app". It is the wrong instrument for "does the
// checker reject what Apple rejects" - asserting that check-aasa.sh contains
// the string `%{http_code}` pins a spelling and proves nothing about the
// answer. That distinction is the whole of guards-that-do-not-guard mode 0.
//
// And the checker DID have a hole a scan would not have found. It fetched with
// `curl -fsSL`; -L follows redirects, which Apple does not. Pointed at
// http://gradethread.com/.well-known/... - a real 301 - it printed OK and
// exited 0. "Served as application/json with no redirect" is the literal
// wording of this story's AC2, and those were exactly the two conditions the
// probe could not see.
//
// So this block starts a local http server that serves each way the file can be
// wrong, and runs the real script against it. It is offline (127.0.0.1), so it
// belongs in the normal suite; the live domain stays the uptime job's business,
// because only a network fetch can see a redirect rule added in the Cloudflare
// dashboard, which exists nowhere in this repo.

const SCRIPT = root("ios/Scripts/check-aasa.sh").replace(/\\/g, "/");

// A deliberately fake team id. The real one belongs in $APPLE_TEAM_ID and in
// no source file - see the "hard-codes no team id" case above. A fixture that
// carried the production value would reintroduce exactly the stale third copy
// that caused this story to be filed against a working production file.
const FAKE_APP_ID = "ABCDE12345.com.gradethread.app";

const OK_BODY = JSON.stringify({
  applinks: {
    details: [
      {
        appIDs: [FAKE_APP_ID],
        components: [{ "/": "/app/oauth/*" }, { "/": "/app/auth-callback*" }],
      },
    ],
  },
  webcredentials: { apps: [FAKE_APP_ID] },
});

/** `sh` is not on PATH for a child process on Windows; Git ships `bash`. */
function resolveShell(): string {
  for (const candidate of ["sh", "bash"]) {
    if (spawnSync(candidate, ["-c", "exit 0"]).status === 0) return candidate;
  }
  // Throw rather than skip. A guard that quietly does not run is worse than
  // one that is absent, because the green reads as evidence.
  throw new Error("neither sh nor bash is runnable; cannot exercise check-aasa.sh");
}

describe("US-3108: check-aasa.sh rejects what Apple rejects", () => {
  let server: Server;
  let base = "";
  let shell = "";

  beforeAll(async () => {
    shell = resolveShell();
    server = createServer((req, res) => {
      switch (req.url) {
        case "/ok":
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(OK_BODY);
        case "/redirect":
          // The failure -L hid: a correct file one hop away is still dead.
          res.writeHead(301, { Location: "/ok" });
          return res.end();
        case "/redirect-json":
          // A 302 that ALSO carries the right Content-Type and the right body.
          // Without this the redirect case is caught by the Content-Type gate
          // instead - deleting the status gate outright left the whole suite
          // green until this fixture existed, which is the sabotage run earning
          // its keep. Each gate needs a case that only IT can catch.
          res.writeHead(302, {
            Location: "/ok",
            "Content-Type": "application/json; charset=utf-8",
          });
          return res.end(OK_BODY);
        case "/notfound-json":
          // Correct type, correct body, wrong status. Isolates the status gate.
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(OK_BODY);
        case "/html":
          // An SPA or 404 catch-all standing in for a removed Pages Function.
          // The body is valid JSON, so only the Content-Type gives it away.
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          return res.end(OK_BODY);
        case "/no-type":
          res.writeHead(200);
          return res.end(OK_BODY);
        case "/unconfigured":
          // What the Pages Function serves with APPLE_TEAM_ID unset.
          res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ error: "Universal Links not configured" }));
        case "/blank-bundle":
          // The pre-US-2620 regression: a blank IOS_BUNDLE_ID served as 200.
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ applinks: { details: [{ appIDs: ["ABCDE12345."] }] } }));
        case "/truncated":
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          return res.end('{"applinks":');
        default:
          res.writeHead(404, { "Content-Type": "text/plain" });
          return res.end("nope");
      }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  // MUST be async. spawnSync blocks this process's event loop, so the fixture
  // server above can never answer the curl the child just made: the script
  // waits on a server that is waiting on the script. That deadlock does not
  // even hit a vitest timeout, because the timer cannot fire either.
  function run(
    path: string,
    args: string[] = [],
  ): Promise<{ status: number | null; out: string }> {
    return new Promise((done) => {
      const child = spawn(shell, [SCRIPT, ...args], {
        env: {
          ...process.env,
          AASA_URL: `${base}${path}`,
          // Must be cleared, or a team id in the ambient environment silently
          // changes which branch of the script is under test.
          APPLE_TEAM_ID: "",
          IOS_BUNDLE_ID: "com.gradethread.app",
        },
        timeout: 15_000,
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("error", (e) => done({ status: -1, out: `${out}${e}` }));
      child.on("close", (status) => done({ status, out }));
    });
  }

  it("accepts a correctly served file", async () => {
    const { status, out } = await run("/ok");
    expect(out).toContain("OK: AASA served");
    expect(status).toBe(0);
  });

  it("accepts an exact appID match and rejects a wrong one", async () => {
    expect((await run("/ok", [FAKE_APP_ID])).status).toBe(0);
    const wrong = await run("/ok", ["ZZZZZ99999.com.gradethread.app"]);
    expect(wrong.status).not.toBe(0);
    expect(wrong.out).toContain("does not list appID");
  });

  it("rejects a redirect, even when the destination is correct", async () => {
    // This is the case that passed before US-3108's second pass.
    for (const path of ["/redirect", "/redirect-json"]) {
      const { status, out } = await run(path);
      expect(out, `${path} must name the redirect`).toContain("redirect");
      expect(status, `${path} must exit non-zero`).not.toBe(0);
    }
  });

  it("rejects a non-200 that is otherwise perfectly formed", async () => {
    // Right Content-Type, right body, wrong status. Nothing else in this suite
    // can catch that, which is the point: one case per gate.
    const { status, out } = await run("/notfound-json");
    expect(out).toContain("HTTP 404");
    expect(status).not.toBe(0);
  });

  it("rejects a 200 that is not application/json", async () => {
    for (const path of ["/html", "/no-type"]) {
      const { status, out } = await run(path);
      expect(out, `${path} must fail on Content-Type`).toContain("Content-Type");
      expect(status, `${path} must exit non-zero`).not.toBe(0);
    }
  });

  it("rejects an unconfigured deploy and a blank bundle id", async () => {
    expect((await run("/unconfigured")).status).not.toBe(0);
    // "ABCDE12345." is a 200 with valid JSON and the right Content-Type. Only
    // the appID shape check catches it.
    const blank = await run("/blank-bundle");
    expect(blank.out).toContain("no well-formed appID");
    expect(blank.status).not.toBe(0);
  });

  it("rejects a body that does not parse despite a JSON Content-Type", async () => {
    const { status, out } = await run("/truncated");
    // Skipping silently when python is absent is itself a failure mode, so the
    // script says which path it took and this asserts one of the two happened.
    expect(out).toMatch(/not valid JSON|no python on PATH/);
    if (!out.includes("no python on PATH")) expect(status).not.toBe(0);
  });
});
