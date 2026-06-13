// US-573: grading image-buffer concurrency cap.
//
// withImageBufferSlot must bound how many pipelines hold base64 image data
// resident at once, so concurrent grading can't OOM the container.
//
//   deno test --allow-env src/tests/grading-capacity_test.ts
import { assert, assertEquals } from "@std/assert";

// The semaphore is sized on first use from this env, fixed for the process —
// so set it BEFORE importing the module under test.
Deno.env.set("GRADING_MAX_CONCURRENT_PIPELINES", "2");

const { withImageBufferSlot, gradingBufferConcurrency } = await import(
  "../lib/grading-capacity.ts"
);

Deno.test("gradingBufferConcurrency reads the env override", () => {
  assertEquals(gradingBufferConcurrency(), 2);
});

Deno.test("withImageBufferSlot never lets more than the cap run at once", async () => {
  let active = 0;
  let peak = 0;
  const release: Array<() => void> = [];

  // Start 5 slots; each parks on a manual gate so we can observe how many the
  // semaphore admitted concurrently.
  const runs = Array.from({ length: 5 }, () =>
    withImageBufferSlot(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => release.push(resolve));
      active--;
    }));

  // Let the event loop admit the first wave.
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(active, 2, "only 2 should be admitted initially");

  // Drain one at a time; the cap must hold throughout.
  while (release.length > 0) {
    release.shift()!();
    await new Promise((r) => setTimeout(r, 5));
    assert(active <= 2, `cap breached: ${active} active`);
  }

  await Promise.all(runs);
  assertEquals(peak, 2, "concurrency peaked at the cap, never above");
});

Deno.test("withImageBufferSlot releases the slot even when fn throws", async () => {
  // After a throw, a subsequent run must still acquire a slot (no leak).
  await withImageBufferSlot(() => Promise.reject(new Error("boom"))).catch(
    () => {},
  );
  let ran = false;
  await withImageBufferSlot(() => {
    ran = true;
    return Promise.resolve();
  });
  assert(ran, "slot leaked after a throwing run");
});
