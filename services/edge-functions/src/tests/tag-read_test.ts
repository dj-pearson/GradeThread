// US-9033: the free tag reader's defences and its one write.
//
// US-2379: public-grading.ts reaches lib/supabase.ts, which throws at import
// without credentials, so _env.ts comes first.
//
//   deno test --allow-env --allow-read src/tests/tag-read_test.ts

import "./_env.ts";
import { assertEquals } from "@std/assert";
import {
  afterTagRead,
  publicTagRead,
  tagReadRateLimited,
} from "../routes/public-grading.ts";

Deno.test("the sixth read from one IP in an hour is refused", () => {
  const now = Date.now();
  const ip = "203.0.113.7";
  for (let i = 0; i < 5; i++) {
    assertEquals(tagReadRateLimited(ip, now), false, `call ${i + 1}`);
  }
  assertEquals(tagReadRateLimited(ip, now), true);
});

Deno.test("the window rolls, so the limit is not permanent", () => {
  const ip = "203.0.113.8";
  const now = Date.now();
  for (let i = 0; i < 5; i++) tagReadRateLimited(ip, now);
  assertEquals(tagReadRateLimited(ip, now), true);
  // An hour and a second later.
  assertEquals(tagReadRateLimited(ip, now + 60 * 60 * 1000 + 1000), false);
});

Deno.test("one IP's limit is not another's", () => {
  const now = Date.now();
  for (let i = 0; i < 5; i++) tagReadRateLimited("203.0.113.9", now);
  assertEquals(tagReadRateLimited("203.0.113.9", now), true);
  assertEquals(tagReadRateLimited("203.0.113.10", now), false);
});

const field = (value: string, confidence = 0.9) => ({ value, confidence });

Deno.test("a confident read comes back whole", () => {
  const out = publicTagRead({
    brand: field("Vuori"),
    size: field("M"),
    fiber_content: field("88% polyester 12% elastane"),
    style_code: field("V310"),
    rn_number: field("RN 156509"),
  });
  assertEquals(out.brand, "Vuori");
  assertEquals(out.rn, "RN 156509");
  assertEquals(out.styleCode, "V310");
});

Deno.test("a low-confidence field is dropped rather than guessed at", () => {
  // A wrong RN sends someone to the wrong company with our name on the answer.
  const out = publicTagRead({ rn_number: field("RN 99999", 0.2), size: field("L", 0.95) });
  assertEquals(out.rn, null);
  assertEquals(out.size, "L");
});

Deno.test("an empty or missing field is null, never a blank string", () => {
  const out = publicTagRead({ rn_number: field("   "), brand: undefined });
  assertEquals(out.rn, null);
  assertEquals(out.brand, null);
});

Deno.test("a read carrying an RN records exactly one sighting", async () => {
  const writes: Array<{ registryKey: string; declaredBrand?: string }> = [];
  await afterTagRead({ rn: "RN 56323", brand: "Nike" }, {
    writer: (args) => {
      writes.push(args);
      return Promise.resolve();
    },
  });
  assertEquals(writes.length, 1);
  assertEquals(writes[0].registryKey, "RN:56323");
  assertEquals(writes[0].declaredBrand, "Nike");
});

Deno.test("every spelling records the same key", async () => {
  for (const raw of ["RN 56323", "rn56323", "RN# 56323", "056323", "56323"]) {
    const writes: string[] = [];
    await afterTagRead({ rn: raw, brand: null }, {
      writer: (a) => {
        writes.push(a.registryKey);
        return Promise.resolve();
      },
    });
    assertEquals(writes, ["RN:56323"], raw);
  }
});

Deno.test("a read with no number on the label records nothing", async () => {
  // A sighting claims we SAW the number. Inventing one poisons the count the
  // lookup page's credibility rests on.
  for (const rn of [null, "", "   ", "not a number"]) {
    const writes: string[] = [];
    await afterTagRead({ rn, brand: "Nike" }, {
      writer: (a) => {
        writes.push(a.registryKey);
        return Promise.resolve();
      },
    });
    assertEquals(writes, [], JSON.stringify(rn));
  }
});

Deno.test("a CA number is recorded under its own registry", async () => {
  const writes: string[] = [];
  await afterTagRead({ rn: "CA 32054", brand: null }, {
    writer: (a) => {
      writes.push(a.registryKey);
      return Promise.resolve();
    },
  });
  assertEquals(writes, ["CA:32054"]);
});
