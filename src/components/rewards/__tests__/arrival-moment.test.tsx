// US-2973: the arrival moment — the one-time "your work counted" card the
// pipeline-XP backfill produces.
//
// The thing worth guarding here is WHY it exists. The client-side celebration
// runner cannot deliver this: detectCelebrations returns [] when the previous
// snapshot is null, that snapshot lives in localStorage, and a seller who has
// never opened the rewards page is close to a definition of who the backfill is
// for. So the arrival is server-decided, and the page must show it INSTEAD of
// the runner — one clear moment, not that plus a stack of badge toasts for
// badges the same backfill just awarded.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ArrivalMoment } from "@/components/rewards/arrival-moment";
import type { RewardArrival } from "@/hooks/use-rewards";

function render(arrival: RewardArrival, tierName = "Curator") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ArrivalMoment arrival={arrival} tierName={tierName} />
    </QueryClientProvider>,
  );
}

describe("ArrivalMoment", () => {
  it("leads with what happened and names the tier", () => {
    const html = render({ level: 7, badgeCount: 4 });
    expect(html).toContain("Your work counted");
    expect(html).toContain("Curator");
    expect(html).toContain("level");
    expect(html).toContain("7");
  });

  it("counts badges, and pluralises one badge correctly", () => {
    expect(render({ level: 7, badgeCount: 4 })).toContain("4 badges");
    expect(render({ level: 3, badgeCount: 1 })).toContain("1 badge");
  });

  it("says nothing about badges when there are none", () => {
    const html = render({ level: 2, badgeCount: 0 });
    expect(html).not.toContain("badge");
    expect(html).toContain("Your work counted");
  });

  it("promises the level is permanent, because that is the point", () => {
    expect(render({ level: 7, badgeCount: 0 })).toContain("never go down");
  });

  it("offers a dismiss control", () => {
    expect(render({ level: 7, badgeCount: 2 })).toContain("Got it");
  });
});

describe("the rewards page wiring", () => {
  const page = readFileSync(resolve(process.cwd(), "src/pages/rewards.tsx"), "utf8");

  it("renders the arrival INSTEAD of the celebration runner, not alongside it", () => {
    // Both at once is the failure this replaces: an arrival card plus a toast
    // per badge the backfill just granted.
    expect(page).toContain("<ArrivalMoment");
    expect(page).toMatch(/arrival[\s\S]{0,200}<ArrivalMoment[\s\S]{0,200}<RewardCelebrations \/>/);
  });

  it("takes the tier name from the level block rather than re-deriving it", () => {
    expect(page).toContain("tierName={level.tier.name}");
  });
});

describe("the arrival component", () => {
  const src = readFileSync(
    resolve(process.cwd(), "src/components/rewards/arrival-moment.tsx"),
    "utf8",
  );

  it("acknowledges server-side so the moment cannot re-fire on another device", () => {
    expect(src).toContain('edgeFetch("/api/rewards/arrival/ack"');
    // Comments stripped: the component's own header explains why localStorage
    // is the wrong home for this, and scanning raw text would match that
    // explanation rather than a real use.
    const code = src
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    expect(code).not.toContain("localStorage");
  });

  it("fires confetti, which already declines under reduced motion", () => {
    expect(src).toContain("<ConfettiBurst");
  });

  it("dismisses optimistically and swallows an ack failure", () => {
    // A failed ack costs at most one repeat showing. Blocking the dismiss on a
    // network round-trip would be worse than that.
    expect(src).toContain("setDismissed(true)");
    expect(src).toMatch(/setDismissed\(true\);[\s\S]{0,80}try \{/);
  });
});
