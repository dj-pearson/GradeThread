import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_LAYOUTS,
  widgetById,
  widgetsForSurface,
  widgetWindowPhrase,
} from "@/lib/dashboard-widgets";
import { dropsDueWithin, type ScheduledDropRow } from "@/hooks/use-scheduled-drops";
import { countActionsSince, type AutomationActionRow } from "@/hooks/use-automations";
import { NEEDS_YOU_HREF, NEEDS_YOU_QUEUES } from "@/hooks/use-needs-you";

// US-3077: the eight action widgets.
//
// Three kinds of claim, and each is here because it is the kind that breaks
// quietly: the registry entries (a size in a default that the widget does not
// offer renders at a width it was never drawn for), the two pure helpers behind
// the counts, and the boundary AC10 draws around the whole story.

const ACTION_IDS = [
  "flipdesk.needs-you",
  "flipdesk.offers",
  "flipdesk.extension-queue",
  "flipdesk.sync-conflicts",
  "flipdesk.autolister-drafts",
  "flipdesk.scheduled-drops",
  "flipdesk.automations",
  "flipdesk.repricing",
] as const;

const registry = widgetsForSurface("flipdesk");

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("the eight action widgets are registered (US-3077)", () => {
  it("files every one under 'action', for FlipDesk personas only", () => {
    for (const id of ACTION_IDS) {
      const def = widgetById(id, registry);
      expect(def, `${id} is not registered`).toBeDefined();
      expect(def!.category, id).toBe("action");
      // A buyer has no FlipDesk surface: a flipdesk.* card on that board would
      // query rows the account cannot read and render an error forever.
      expect(def!.personas, id).not.toContain("buyer");
      expect(def!.sizes, id).toContain(def!.defaultSize);
    }
  });

  it("allows exactly the sizes the story fixes", () => {
    const expected: Record<string, { sizes: string[]; def: string }> = {
      // AC2 wants five rows at md and ten at lg, so md and lg are the sizes
      // this one is legible at; sm cannot hold a row with a badge, a title, an
      // amount and a clock.
      "flipdesk.needs-you": { sizes: ["md", "lg"], def: "lg" },
      "flipdesk.offers": { sizes: ["sm", "md"], def: "sm" },
      "flipdesk.extension-queue": { sizes: ["sm", "md"], def: "sm" },
      "flipdesk.sync-conflicts": { sizes: ["sm", "md"], def: "sm" },
      "flipdesk.autolister-drafts": { sizes: ["sm", "md"], def: "sm" },
      "flipdesk.scheduled-drops": { sizes: ["sm", "md"], def: "sm" },
      "flipdesk.automations": { sizes: ["sm", "md"], def: "sm" },
      "flipdesk.repricing": { sizes: ["sm", "md"], def: "sm" },
    };
    for (const [id, want] of Object.entries(expected)) {
      const def = widgetById(id, registry)!;
      expect(def.sizes, id).toEqual(want.sizes);
      expect(def.defaultSize, id).toBe(want.def);
    }
  });

  it("puts only needs-you on the default board, and puts it first", () => {
    for (const persona of ["seller", "consignment", "developer"] as const) {
      const layout = DEFAULT_LAYOUTS.flipdesk[persona];
      expect(layout[0]?.id, persona).toBe("flipdesk.needs-you");
      const onBoard = layout
        .map((e) => e.id)
        .filter((id) => (ACTION_IDS as readonly string[]).includes(id));
      expect(onBoard, persona).toEqual(["flipdesk.needs-you"]);
    }
  });

  it("uses a size the widget actually offers, in every default entry", () => {
    // The failure this catches: a default naming "lg" for a widget whose
    // `sizes` array stops at "md" renders a card at a width nobody drew it for.
    for (const persona of ["seller", "consignment", "developer"] as const) {
      for (const entry of DEFAULT_LAYOUTS.flipdesk[persona]) {
        expect(widgetById(entry.id)!.sizes, `${entry.id} at ${entry.size}`).toContain(
          entry.size,
        );
      }
    }
  });

  it("never stamps the range picker's phrase on a live queue", () => {
    // Every one of the eight is a snapshot or has its own fixed window. "12
    // open offers in the last 30 days" would be false about both halves.
    for (const id of ACTION_IDS) {
      expect(widgetById(id, registry)!.rangeAware, id).toBe(false);
    }
    expect(widgetWindowPhrase(widgetById("flipdesk.scheduled-drops")!, "d30")).toBe(
      "in the next 7 days",
    );
    expect(widgetWindowPhrase(widgetById("flipdesk.automations")!, "d30")).toBe(
      "in the last 7 days",
    );
    expect(widgetWindowPhrase(widgetById("flipdesk.offers")!, "d30")).toBe(
      "right now",
    );
  });
});

describe("the needs-you merge moved into a hook (US-3077 AC1)", () => {
  it("names all six queues and sends each kind somewhere absolute", () => {
    expect([...NEEDS_YOU_QUEUES]).toEqual([
      "returns",
      "cancellations",
      "inquiries",
      "cases",
      "disputes",
      "offers",
    ]);
    // The widget renders on the overview, where a bare "#returns" scrolls to
    // nothing. Every destination has to be a path.
    for (const href of Object.values(NEEDS_YOU_HREF)) {
      expect(href.startsWith("/dashboard/flipdesk/"), href).toBe(true);
    }
  });

  it("leaves the card rendering the list and reading nothing itself", () => {
    const card = read("src/components/flipdesk/needs-you-card.tsx");
    expect(card).toContain("useNeedsYou");
    // The six reads and the merge are the hook's now. A second copy here is
    // how the card and the widget would come to disagree about "open".
    expect(card).not.toContain("useEbayReturns");
    expect(card).not.toContain("splitByOpenState");
    expect(card).not.toContain("rankNeedsYou");
  });

  it("keeps the ranking pure and separate from the reading", () => {
    // src/pages/flipdesk/__tests__/needs-you.test.ts tests rankNeedsYou against
    // this module and must never need a query client to do it.
    const ranking = read("src/pages/flipdesk/needs-you.ts");
    expect(ranking).not.toContain("useQuery");
    expect(ranking).not.toContain("@/hooks/");
  });
});

describe("the pages kept working through the extracted hooks (AC6, AC7)", () => {
  it("gives the drafts cockpit and the widget one read", () => {
    const page = read("src/pages/flipdesk/autolister-drafts.tsx");
    expect(page).toContain("useAutolisterDrafts");
    // Not a second copy of the same query beside the hook: two reads of the
    // same rows eventually show two different numbers. (The page still
    // INVALIDATES that key after a bulk edit, which is the opposite problem.)
    expect(page).not.toContain('queryKey: ["autolister_drafts", user?.id]');
    expect(page).not.toContain("fetchCapped");
  });

  it("gives the drops calendar and the widget one read", () => {
    const page = read("src/pages/flipdesk/scheduled-drops.tsx");
    expect(page).toContain("useScheduledDrops");
    expect(page).not.toContain('queryKey: ["scheduled_drops"');
    expect(page).not.toContain("fetchCapped");
  });
});

describe("dropsDueWithin (US-3077 AC7)", () => {
  const NOW = Date.parse("2026-09-02T12:00:00Z");
  const drop = (id: string, iso: string): ScheduledDropRow => ({
    id,
    inventory_item_id: `item-${id}`,
    listing_title: id,
    listing_price: 40,
    scheduled_publish_at: iso,
    promo_opt_out: null,
    promo_rate_pct: null,
  });

  it("keeps the next seven days, soonest first", () => {
    const out = dropsDueWithin(
      [
        drop("in-six-days", "2026-09-08T12:00:00Z"),
        drop("tomorrow", "2026-09-03T12:00:00Z"),
      ],
      7,
      NOW,
    );
    expect(out.map((d) => d.id)).toEqual(["tomorrow", "in-six-days"]);
  });

  it("drops anything already past, rather than calling it due", () => {
    // A drop whose time has come is either mid-publish or stuck. Counting it as
    // "due in the next seven days" tells the seller to wait for something that
    // has already had its turn.
    const out = dropsDueWithin([drop("yesterday", "2026-09-01T12:00:00Z")], 7, NOW);
    expect(out).toEqual([]);
  });

  it("drops anything past the window, and anything undated", () => {
    const out = dropsDueWithin(
      [
        drop("next-month", "2026-10-02T12:00:00Z"),
        drop("garbage", "not-a-date"),
        drop("in-window", "2026-09-05T12:00:00Z"),
      ],
      7,
      NOW,
    );
    expect(out.map((d) => d.id)).toEqual(["in-window"]);
  });
});

describe("countActionsSince (US-3077 AC8)", () => {
  const NOW = Date.parse("2026-09-02T12:00:00Z");
  const SINCE = NOW - 7 * 24 * 60 * 60 * 1000;
  const action = (created_at: string): AutomationActionRow =>
    ({ created_at }) as AutomationActionRow;

  it("adds up every rule's log and ignores anything older than the window", () => {
    const n = countActionsSince(
      [
        [action("2026-09-01T00:00:00Z"), action("2026-08-01T00:00:00Z")],
        [action("2026-08-30T00:00:00Z")],
      ],
      SINCE,
    );
    expect(n).toBe(2);
  });

  it("counts a rule whose log has not answered yet as nothing, not as a crash", () => {
    expect(countActionsSince([undefined, [action("2026-09-01T00:00:00Z")]], SINCE)).toBe(
      1,
    );
  });
});

describe("the boundary AC10 draws", () => {
  const WIDGET_FILES = ACTION_IDS.map(
    (id) => `src/components/dashboard/widgets/${id.replace("flipdesk.", "flipdesk-")}.tsx`,
  );

  it("keeps every widget off supabase and off the edge directly", () => {
    // No new edge route and no new table means no widget invents a read of its
    // own: each one goes through a hook that already existed or that this story
    // extracted from a page.
    for (const file of WIDGET_FILES) {
      const src = read(file);
      expect(src, `${file} reads supabase directly`).not.toContain(
        '@/lib/supabase"',
      );
      expect(src, `${file} calls the edge directly`).not.toContain(
        '@/lib/edge-fetch"',
      );
    }
  });

  it("gives every widget a skeleton and a retry", () => {
    for (const file of WIDGET_FILES) {
      const src = read(file);
      expect(src, `${file} has no loading state`).toMatch(
        /StatTileSkeleton|LoadingRegion/,
      );
      expect(src, `${file} has no error retry`).toContain("WidgetLoadError");
    }
  });

  it("names the plan on the gated one rather than hiding it", () => {
    // US-2872: a `requiresFlipdeskFlag` gate renders visible-but-locked. A
    // hidden feature cannot be wanted.
    const src = read(
      "src/components/dashboard/widgets/flipdesk-autolister-drafts.tsx",
    );
    expect(src).toContain('explainGate("autolister")');
    expect(src).toContain("requiredPlanLabel");
    expect(src).toContain("showUpgrade");
  });

  it("leaves the overview page a header and a board", () => {
    // Eight more widgets must not put a single line of card markup back on the
    // page: the whole point of US-3076 was that the page stopped placing cards.
    const page = read("src/pages/flipdesk/overview.tsx");
    expect(page.split("\n").length).toBeLessThan(120);
    expect(page).toContain("<CustomizableWidgetBoard");
    for (const id of ACTION_IDS) {
      expect(page, `${id} is drawn by the page`).not.toContain(id);
    }
  });
});
