import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// US-2585: measuring whether the help centre prevented a ticket.
//
// Two numbers justify this feature. Organic traffic is easy — it shows up in
// Search Console. Tickets PREVENTED is the hard one, because the event is
// somebody NOT doing something, and there is no row in the database it could
// hang on. That is why deflection is usually a guess, and why this is worth
// guarding.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("the deflector sits where it can work", () => {
  const src = read("src/pages/support-tickets.tsx");

  it("renders ABOVE the submit button", () => {
    // A suggestion below the submit button is a suggestion nobody reads.
    const deflector = src.indexOf("<TicketDeflector");
    const submit = src.indexOf("onClick={submitNew}");
    expect(deflector).toBeGreaterThan(-1);
    expect(submit).toBeGreaterThan(-1);
    expect(deflector).toBeLessThan(submit);
  });

  it("is driven by the subject line as it is typed", () => {
    expect(src).toContain("subject={newSubject}");
  });

  it("sends what was shown and what was opened with the ticket", () => {
    expect(src).toContain("help_articles_shown: helpSuggested.shown");
    expect(src).toContain("help_article_opened: helpSuggested.opened");
  });
});

describe("the suggestions come from the AUTHED search", () => {
  const src = read("src/components/help/ticket-deflector.tsx");

  it("uses the reader search, so a member's own articles are eligible", () => {
    // The form only exists on an authenticated surface, so restricting it to
    // public articles would hide answers the person is entitled to.
    expect(src).toContain("useHelpReaderSearch");
    expect(src).not.toContain("usePublicHelpSearch");
  });

  it("debounces, so a search does not fire per keystroke", () => {
    expect(src).toContain("DEBOUNCE_MS");
    expect(src).toContain("setTimeout");
  });

  it("shows at most three", () => {
    expect(src).toContain("SUGGESTION_LIMIT = 3");
  });

  it("renders nothing when nothing matched", () => {
    expect(src).toContain("if (hits.length === 0) return null;");
  });
});

describe("the deflection is recorded when the page goes away", () => {
  const src = read("src/components/help/ticket-deflector.tsx");

  it("uses sendBeacon, because by then a fetch would be cancelled", () => {
    expect(src).toContain("navigator.sendBeacon");
  });

  it("listens on visibilitychange, not unload", () => {
    // unload is unreliable on mobile Safari and is ignored entirely when the
    // tab is discarded from the background.
    expect(src).toContain("visibilitychange");
    expect(src).not.toMatch(/addEventListener\(\s*["']unload["']/);
  });

  it("only fires when an article was actually opened", () => {
    // Nothing read means nothing deflected. Recording it anyway would inflate
    // the one number this exists to keep honest.
    expect(src).toContain("if (!s.opened) return;");
  });
});

describe("the edge endpoint", () => {
  const src = read("services/edge-functions/src/routes/help-center.ts");

  it("refuses to record a deflection with no article opened", () => {
    const block = src.slice(src.indexOf('helpReaderRoutes.post("/deflected"'));
    expect(block).toContain("if (!opened) return c.json({ ok: true, recorded: false });");
  });

  it("bounds the client-supplied slugs rather than trusting them", () => {
    const block = src.slice(src.indexOf('helpReaderRoutes.post("/deflected"'));
    expect(block).toContain("/^[a-z0-9-]{1,80}$/");
    expect(block).toContain(".slice(0, 5)");
  });

  it("never fails loudly — the page has already been left", () => {
    // Bounded to THIS handler, not to the next GET. Slicing that far swept in
    // every route registered between them, so the assertion started reporting
    // on a neighbour's error handling (US-2592).
    const start = src.indexOf('helpReaderRoutes.post("/deflected"');
    const end = src.indexOf("helpReaderRoutes.", start + 1);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).toContain("console.warn");
    expect(block).not.toContain("failSafe(c, 500");
  });

  it("is on the AUTHED mount, so it cannot be written anonymously", () => {
    const main = read("services/edge-functions/src/main.ts");
    expect(main).toContain('app.use("/api/help/*", authMiddleware);');
    expect(src).toContain("helpReaderRoutes.post");
  });
});

describe("the ticket route bounds what the client sends", () => {
  const src = read("services/edge-functions/src/routes/support-tickets.ts");

  it("validates the slug shape and caps the count", () => {
    expect(src).toContain("/^[a-z0-9-]{1,80}$/");
    expect(src).toContain("help_articles_shown: helpShown");
    expect(src).toContain("help_article_opened: helpOpened");
  });

  it("nulls an unparseable opened slug rather than storing junk", () => {
    expect(src).toContain(
      "const helpOpened = /^[a-z0-9-]{1,80}$/.test(rawOpened) ? rawOpened : null;",
    );
  });
});

describe("the schema", () => {
  const sql = read("supabase/migrations/00604_help_ticket_deflection.sql");

  it("adds both ticket columns idempotently", () => {
    expect(sql).toContain("add column if not exists help_articles_shown");
    expect(sql).toContain("add column if not exists help_article_opened");
  });

  it("creates help_deflections with deny-all RLS and no policy", () => {
    expect(sql).toContain("create table if not exists public.help_deflections");
    expect(sql).toContain("alter table public.help_deflections enable row level security");
    expect(sql).not.toMatch(/create policy[^;]*help_deflections/);
  });

  it("names its owner column owner_user_id, not user_id", () => {
    // rls-guard classifies a table by that literal column name, and this is an
    // analytics row about a session, not a tenant-owned resource.
    expect(sql).toContain("owner_user_id");
    const createBlock = sql.slice(
      sql.indexOf("create table if not exists public.help_deflections"),
      sql.indexOf("create index if not exists idx_help_deflections_created_at"),
    );
    expect(createBlock).not.toMatch(/\buser_id\b\s+uuid/);
  });

  it("is classified in SERVICE_ROLE_ONLY", () => {
    expect(read("services/edge-functions/src/tests/rls-guard_test.ts")).toContain(
      '"help_deflections"',
    );
  });

  it("self-records its version", () => {
    expect(sql).toContain("insert into public.applied_migrations (version) values ('00604')");
  });
});
