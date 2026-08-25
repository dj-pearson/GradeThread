// US-2845 AC2 + AC3: prove the two things that are NOT here.
//
// These are the claims the whole feature's legitimacy rests on, and they are
// the kind that decay quietly. Nobody sets out to add a crawler; somebody adds
// "just enumerate the top categories to warm the cache" and it is one.
//
//   AC2  no catalogue-wide crawl exists anywhere in the code
//   AC3  reads go through searchBrowseComps, and no marketplace HTML is parsed
//
// Both are asserted against the SOURCE, because neither can be proven by
// exercising the worker: a crawler that nobody calls is still a crawler, and it
// would pass every behavioural test in the suite.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { COMP_READ_FEATURE } from "../lib/comp-read-worker.ts";

const ROOT = new URL("../", import.meta.url);

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(rel, ROOT));
}

const COMP_READ_FILES = [
  "lib/comp-read-worker.ts",
  "lib/comp-read-demand.ts",
  "routes/jobs-comp-read.ts",
];

/** Comments are not code. The files argue about crawling; they must not crawl. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => {
      const i = line.search(/(^|[^:])\/\//);
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
}

Deno.test("AC3: the only marketplace call is the Browse client", async () => {
  for (const rel of COMP_READ_FILES) {
    const code = codeOnly(await read(rel));
    // A bare fetch to a marketplace host is the shape scraping takes.
    for (const host of ["ebay.com", "www.ebay.com", "poshmark", "depop", "mercari", "vinted"]) {
      assert(!code.includes(host), `${rel} reaches ${host} directly`);
    }
    // The tells of HTML parsing.
    for (const tell of ["DOMParser", "cheerio", "querySelector", "innerHTML", "text/html"]) {
      assert(!code.includes(tell), `${rel} parses HTML (${tell})`);
    }
  }
  // And the route really does use the API client.
  const route = await read("routes/jobs-comp-read.ts");
  assert(route.includes("searchBrowseComps"), "the worker does not use searchBrowseComps");
  assert(
    route.includes('from "../lib/ebay-client.ts"'),
    "the worker does not import the eBay client",
  );
});

Deno.test("AC3: the worker fetches images and nothing else", async () => {
  // hashPhotos fetches the listing photo bytes, which is a fetch of an image
  // URL eBay's own API handed us, not a page request. If a second network call
  // ever appears here, it needs a reason and a reader needs to see it.
  const code = codeOnly(await read("routes/jobs-comp-read.ts"));
  const fetches = code.match(/(?<![\w.$])fetchWithTimeout\s*\(/g) ?? [];
  assertEquals(fetches.length, 1, "the worker makes a network call that is not the photo fetch");
  // And no BARE fetch at all: US-2321's guard enumerates the legacy sites, and
  // new code does not get added to that list.
  const bare = code.match(/(?<![\w.$])fetch\s*\(/g) ?? [];
  assertEquals(bare.length, 0, "the worker uses a bare fetch instead of fetchWithTimeout");
});

Deno.test("AC2: nothing enumerates a catalogue", async () => {
  for (const rel of COMP_READ_FILES) {
    const code = codeOnly(await read(rel));
    // The shapes a crawl takes: walking the category tree, or paging a search.
    for (
      const tell of [
        "getCategoryTree",
        "fetchCategoryTree",
        "categorySuggestions",
        "suggestCategories",
        "offset:",
        "page++",
        "while (true)",
      ]
    ) {
      assert(!code.includes(tell), `${rel} looks like a crawl (${tell})`);
    }
  }
});

Deno.test("AC2: the queue has exactly one source, and it is a seller asking", async () => {
  // comp_read_demand may be WRITTEN from one place only. A second writer is how
  // a seeding script becomes a crawler without anyone deciding to build one.
  const writers: string[] = [];
  for await (const entry of Deno.readDir(new URL("lib/", ROOT))) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    const code = codeOnly(await read(`lib/${entry.name}`));
    if (code.includes("comp_read_demand_touch")) writers.push(`lib/${entry.name}`);
  }
  for await (const entry of Deno.readDir(new URL("routes/", ROOT))) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    const code = codeOnly(await read(`routes/${entry.name}`));
    if (code.includes("comp_read_demand_touch")) writers.push(`routes/${entry.name}`);
  }
  assertEquals(writers, ["lib/comp-read-demand.ts"]);
});

Deno.test("AC2: the recorder is called from the value choke point", async () => {
  // Every graded, scouted and listed value passes through applyMeasuredCurve,
  // which is why the queue follows demand without any route knowing about it.
  const chokePoint = await read("lib/condition-value.ts");
  assert(chokePoint.includes("recordCompDemand"), "the queue is not fed from valueAtGrade");
  assert(
    chokePoint.includes("applyMeasuredCurve"),
    "the choke point this test assumes has moved",
  );
});

Deno.test("AC4: the worker checks its budget before reading, not after", async () => {
  const code = codeOnly(await read("routes/jobs-comp-read.ts"));
  // Inside processCell's read loop, before the grader is called.
  const loopStart = code.indexOf("for (const read of plan.reads)");
  const gradeCall = code.indexOf("quickGrade(", loopStart);
  const budgetCheck = code.indexOf("isAiBudgetExhausted", loopStart);
  assert(loopStart > 0, "the read loop has moved");
  assert(budgetCheck > 0 && budgetCheck < gradeCall, "the budget is checked after the spend");
  assert(code.includes(`isAiBudgetExhausted(COMP_READ_FEATURE)`), "the wrong budget is checked");
  assertEquals(COMP_READ_FEATURE, "comp_read");
});

Deno.test("AC4: a read is filed under comp_read, or the budget reads zero forever", async () => {
  // THE QUIET FAILURE THIS PINS. ai_budget_status rolls up ai_usage_events BY
  // FEATURE. A comp read that records its tokens under 'grading' (quickGrade's
  // caller-supplied default elsewhere), or records nothing at all, leaves the
  // comp_read budget at $0 no matter how much it spends. The kill switch would
  // still be wired, still be tested, and never fire.
  const code = codeOnly(await read("routes/jobs-comp-read.ts"));
  assert(code.includes("recordAiUsage("), "comp reads write no spend row");
  assert(
    code.includes("feature: COMP_READ_FEATURE"),
    "comp read spend is filed under some other feature",
  );
  // And quickGrade has to hand the tokens back for that to be possible.
  const qg = await read("lib/quick-grade.ts");
  assert(qg.includes("usages,"), "quickGrade no longer returns its token usage");
});

Deno.test("AC4: the spend is not billed to a seller", async () => {
  // The read is platform spend on a market cell. Attributing it to whoever
  // happened to ask about that cell bills the wrong person for a call they
  // never made, which is the jobs-grading-self-consistency argument.
  const code = codeOnly(await read("routes/jobs-comp-read.ts"));
  const at = code.indexOf("feature: COMP_READ_FEATURE");
  assert(at > 0);
  const block = code.slice(Math.max(0, at - 300), at);
  assert(block.includes("userId: null"), "a comp read is billed to a user");
});
