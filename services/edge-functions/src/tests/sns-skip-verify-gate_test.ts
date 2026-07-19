// SES_SNS_SKIP_VERIFICATION must never be able to take effect in production.
//
// Both SES/SNS receivers are unauthenticated public endpoints that act on
// arbitrary recipient addresses, so a forged bounce/complaint is a
// deliverability DoS: an attacker suppresses mail to any address they choose.
// Signature verification is what prevents that, and the skip flag exists only
// so local/dev does not need an outbound cert fetch.
//
// US-1641 gated the flag on !isProduction() in routes/email-sns.ts. The second
// receiver in routes/webhooks.ts was missed for the same flag — while carrying
// a comment stating it "Mirrors the canonical /api/email/ses-notifications
// receiver". The claim of a mirror was there; the mirror was not. Setting
// SES_SNS_SKIP_VERIFICATION=true in prod would have silently made that endpoint
// forgeable.
//
// A behavioural test cannot cover this well: it would have to boot the route
// with a production env and a forged SNS payload. The property is structural,
// so it is checked structurally — every read of the flag must be conjoined with
// !isProduction().
import { assert } from "@std/assert";

const FLAG = "SES_SNS_SKIP_VERIFICATION";

async function sourcesReadingFlag(): Promise<Array<{ file: string; text: string }>> {
  const out: Array<{ file: string; text: string }> = [];
  const root = new URL("../routes/", import.meta.url);
  for await (const entry of Deno.readDir(root)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    const text = await Deno.readTextFile(new URL(entry.name, root));
    if (text.includes(FLAG)) out.push({ file: `routes/${entry.name}`, text });
  }
  return out;
}

Deno.test("every SES_SNS_SKIP_VERIFICATION read is gated on !isProduction()", async () => {
  const files = await sourcesReadingFlag();

  // Without this the test passes vacuously if the flag is renamed or the scan
  // breaks — precisely how a guard stops guarding.
  assert(
    files.length >= 2,
    `expected at least 2 routes reading ${FLAG}, found ${files.length} — ` +
      "the flag was renamed or the scan broke; update this guard rather than deleting it",
  );

  const ungated: string[] = [];
  for (const { file, text } of files) {
    for (const m of text.matchAll(new RegExp(`[^\\n]*${FLAG}[^\\n]*`, "g"))) {
      const line = m[0];
      if (line.trimStart().startsWith("//")) continue; // prose, not a read
      // The gate may sit on the same line or the line above (line-wrapped).
      const idx = text.indexOf(line);
      const window = text.slice(Math.max(0, idx - 200), idx + line.length);
      if (!/!\s*isProduction\s*\(\s*\)/.test(window)) {
        ungated.push(`${file}: ${line.trim()}`);
      }
    }
  }

  assert(
    ungated.length === 0,
    `${FLAG} is read without a !isProduction() gate. In production this flag ` +
      "must be inert: these endpoints are unauthenticated and a forged SNS " +
      "bounce suppresses mail to an arbitrary recipient.\n  " +
      ungated.join("\n  "),
  );
});
