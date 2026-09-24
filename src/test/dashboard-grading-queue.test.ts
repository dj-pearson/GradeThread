import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SUBMISSION_STATUSES } from "@/lib/constants";
import {
  ALL_STATUSES_FILTER,
  ATTENTION_QUIET_STATE,
  ATTENTION_STATUSES,
  emptyQueueCounts,
  formatAge,
  formatStatusLabel,
  statusFilterFromSearch,
  submissionHref,
  submissionsStatusHref,
  tallySubmissionStatuses,
} from "@/lib/dashboard-grading-queue";

// US-3075 AC2 and AC3.

describe("the grading queue tally", () => {
  it("reports every status, zero included", () => {
    const counts = tallySubmissionStatuses([]);
    expect(Object.keys(counts).sort()).toEqual([...SUBMISSION_STATUSES].sort());
    for (const status of SUBMISSION_STATUSES) expect(counts[status]).toBe(0);
  });

  it("counts one grouped read into one number per status", () => {
    const counts = tallySubmissionStatuses([
      { status: "pending" },
      { status: "pending" },
      { status: "completed" },
      { status: "disputed" },
      { status: "pending_review" },
      { status: "pending" },
    ]);
    expect(counts.pending).toBe(3);
    expect(counts.completed).toBe(1);
    expect(counts.disputed).toBe(1);
    expect(counts.pending_review).toBe(1);
    expect(counts.processing).toBe(0);
    expect(counts.failed).toBe(0);
  });

  it("ignores a status the submissions list cannot filter on", () => {
    // The retired-checkout value is a real database enum member that has never
    // been a filter option. A tile for it would link to a filter the list
    // cannot apply. (needs_photos used to be here; DASH-7 made it a status.)
    const counts = tallySubmissionStatuses([
      { status: "expired" },
      { status: null },
      { status: "" },
      { status: "completed" },
    ]);
    expect(counts.completed).toBe(1);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(1);
  });

  it("hands back a fresh zeroed record each time", () => {
    const first = emptyQueueCounts();
    first.pending = 9;
    expect(emptyQueueCounts().pending).toBe(0);
  });

  it("does not read the same rows six times", () => {
    // The rule the AC is actually about, asserted where it can regress: one
    // supabase read in the widget, not one per status.
    const widget = readFileSync(
      resolve(process.cwd(), "src/components/dashboard/widgets/grading-queue.tsx"),
      "utf8",
    );
    const reads = widget.match(/supabase\s*\n?\s*\.from\(/g) ?? [];
    expect(reads.length).toBe(1);
    expect(widget).not.toContain("head: true");
  });
});

describe("where a queue tile goes", () => {
  it("links each status to the list filtered to it", () => {
    for (const status of SUBMISSION_STATUSES) {
      expect(submissionsStatusHref(status)).toBe(
        `/dashboard/submissions?status=${status}`,
      );
    }
  });

  it("links a row to that one submission", () => {
    expect(submissionHref("abc-123")).toBe("/dashboard/submissions/abc-123");
  });
});

describe("what the submissions list opens on", () => {
  it("seeds the filter from a status the list knows", () => {
    for (const status of SUBMISSION_STATUSES) {
      expect(statusFilterFromSearch(`?status=${status}`)).toBe(status);
    }
  });

  it("accepts a URLSearchParams as well as a string", () => {
    const params = new URLSearchParams({ status: "failed", page: "2" });
    expect(statusFilterFromSearch(params)).toBe("failed");
  });

  it("falls back to every status when the parameter is missing or junk", () => {
    expect(statusFilterFromSearch("")).toBe(ALL_STATUSES_FILTER);
    expect(statusFilterFromSearch("?page=3")).toBe(ALL_STATUSES_FILTER);
    expect(statusFilterFromSearch("?status=")).toBe(ALL_STATUSES_FILTER);
    expect(statusFilterFromSearch("?status=nonsense")).toBe(ALL_STATUSES_FILTER);
    // A real enum member the list has never offered as a filter is junk here
    // too: seeding it would open a page whose Status select shows nothing.
    expect(statusFilterFromSearch("?status=expired")).toBe(ALL_STATUSES_FILTER);
  });

  it("is what src/pages/submissions.tsx actually seeds its filter with", () => {
    // The page held `useState<string>("all")` and read no parameter at all
    // before US-3075. This is the assertion that it does now.
    const page = readFileSync(
      resolve(process.cwd(), "src/pages/submissions.tsx"),
      "utf8",
    );
    expect(page).toContain('statusFilterFromSearch } from "@/lib/dashboard-grading-queue"');
    expect(page).toMatch(
      /useState<string>\(\(\) =>\s*statusFilterFromSearch\(searchParams\),?\s*\)/,
    );
    // The garment-type filter still opens on "all" and should, so this is
    // pinned to the status one rather than to the literal.
    expect(page).not.toMatch(/const \[statusFilter[\s\S]{0,40}useState<string>\("all"\)/);
  });
});

describe("needs_photos (DASH-7)", () => {
  it("is a known submission status the list can filter on", () => {
    expect(SUBMISSION_STATUSES).toContain("needs_photos");
    expect(statusFilterFromSearch("?status=needs_photos")).toBe("needs_photos");
  });

  it("is tallied rather than ignored", () => {
    const counts = tallySubmissionStatuses([
      { status: "needs_photos" },
      { status: "needs_photos" },
      { status: "failed" },
    ]);
    expect(counts.needs_photos).toBe(2);
    expect(counts.failed).toBe(1);
  });
});

describe("what needs the seller's attention", () => {
  it("watches the statuses a person has to act on, seller-actionable first", () => {
    expect([...ATTENTION_STATUSES]).toEqual([
      "disputed",
      "needs_photos",
      "failed",
      "pending_review",
    ]);
    // pending and processing are the pipeline working; completed is done.
    expect(ATTENTION_STATUSES).not.toContain("pending");
    expect(ATTENTION_STATUSES).not.toContain("processing");
    expect(ATTENTION_STATUSES).not.toContain("completed");
  });

  it("says exactly one thing when there is nothing", () => {
    expect(ATTENTION_QUIET_STATE).toBe("Nothing waiting on you");
    const widget = readFileSync(
      resolve(process.cwd(), "src/components/dashboard/widgets/grading-attention.tsx"),
      "utf8",
    );
    expect(widget).toContain("ATTENTION_QUIET_STATE");
  });

  it("shows at most five rows, newest first", () => {
    const widget = readFileSync(
      resolve(process.cwd(), "src/components/dashboard/widgets/grading-attention.tsx"),
      "utf8",
    );
    expect(widget).toContain("const MAX_ROWS = 5");
    expect(widget).toContain('.order("created_at", { ascending: false })');
    expect(widget).toContain(".limit(MAX_ROWS)");
  });
});

describe("how long something has been waiting", () => {
  const now = new Date("2026-09-02T12:00:00.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it("reads as a person would say it", () => {
    expect(formatAge(ago(10_000), now)).toBe("just now");
    expect(formatAge(ago(5 * 60_000), now)).toBe("5 min ago");
    expect(formatAge(ago(60 * 60_000), now)).toBe("1 hour ago");
    expect(formatAge(ago(5 * 3600_000), now)).toBe("5 hours ago");
    expect(formatAge(ago(24 * 3600_000), now)).toBe("1 day ago");
    expect(formatAge(ago(9 * 24 * 3600_000), now)).toBe("9 days ago");
    expect(formatAge(ago(60 * 24 * 3600_000), now)).toBe("2 months ago");
    expect(formatAge(ago(400 * 24 * 3600_000), now)).toBe("1 year ago");
  });

  it("treats a future timestamp as now rather than as a negative age", () => {
    // The browser clock and the database clock disagree by seconds routinely,
    // and "-1 min ago" on a dashboard reads as a bug.
    expect(formatAge(new Date(now.getTime() + 90_000).toISOString(), now)).toBe(
      "just now",
    );
  });

  it("says nothing rather than NaN for an unparseable date", () => {
    expect(formatAge("not a date", now)).toBe("");
  });
});

describe("status labels", () => {
  it("title-cases the underscored enum members", () => {
    expect(formatStatusLabel("pending_review")).toBe("Pending Review");
    expect(formatStatusLabel("failed")).toBe("Failed");
  });
});
