// US-3419: the SKU proof must be runnable against a real Postgres, not only
// against a Postgres inside the Supabase CLI's Docker container.
//
// FOUND 2026-09-20 by trying to run it. check-sku-sequences.mjs is what
// vault/20-domain/sku-numbering.md calls "Proof against a real Postgres", and
// it shelled out to `docker exec supabase_db_gradethread psql`. In a Claude
// Code cloud session dockerd starts but no registry blob can be pulled, so
// `supabase db start` never boots -- while Postgres 16 is installed on the box
// and the whole migration directory applies to it from zero. The proof was
// runnable the entire time and the script had no way to be asked.
//
// With --dsn it runs, and all three fixtures pass: the J9999 -> K0000 carry,
// Z9999 reporting exhaustion instead of wrapping, a workspace MEMBER drawing
// from the OWNER's counter, and the sequence table read-only to clients.
//
// These cases EXECUTE the script, because the flag is parsed at runtime and a
// source scan cannot tell a wired flag from a declared one.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = "scripts/check-sku-sequences.mjs";

/** Run it and hand back everything it said, whichever way it exited. */
function run(args) {
  try {
    const stdout = execFileSync("node", [SCRIPT, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out: stdout };
  } catch (err) {
    return {
      code: err.status ?? 1,
      out: String(err.stdout ?? "") + String(err.stderr ?? ""),
    };
  }
}

describe("check-sku-sequences.mjs takes a connection string", () => {
  it("reports the DSN it could not reach, not a container name", () => {
    // Port 1 is never a Postgres. What matters is WHICH failure it reports:
    // before --dsn existed, every unreachable database read as "start the
    // container", which is advice that cannot work where there is no image.
    const { code, out } = run(["--dsn", "postgresql://postgres@127.0.0.1:1/postgres"]);
    expect(code).toBe(2);
    expect(out).toContain("postgresql://postgres@127.0.0.1:1/postgres");
    expect(out).not.toContain("docker start");
  });

  it("still names the container when no DSN is given", () => {
    // The default path is the one CI and the Windows box use, and it keeps its
    // own advice. A flag that silently changed the default would be worse than
    // no flag.
    const { code, out } = run(["--container", "no_such_container_for_this_test"]);
    expect(code).toBe(2);
    expect(out).toContain("no_such_container_for_this_test");
    expect(out).toContain("docker start");
  });

  it("offers the DSN form in the container path's own hint", () => {
    // Whoever hits the container failure is exactly the person who needs to
    // know the other form exists, so the hint carries it.
    const { out } = run(["--container", "no_such_container_for_this_test"]);
    expect(out).toContain("--dsn");
  });
});
