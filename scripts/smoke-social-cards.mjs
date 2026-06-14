// US-871: smoke-fetch the dynamic branded social card in every aspect ratio and
// assert each returns a real PNG. Run against a deployed environment (the card
// is rendered by workers-og at the Cloudflare edge, so there is nothing to boot
// locally):
//
//   node scripts/smoke-social-cards.mjs                         # prod
//   node scripts/smoke-social-cards.mjs https://staging.example # custom base
//   BASE_URL=https://preview.pages.dev node scripts/smoke-social-cards.mjs
//
// Exits non-zero if any ratio fails to return a valid PNG.

const base = (process.argv[2] || process.env.BASE_URL || "https://gradethread.com")
  .replace(/\/$/, "");

const RATIOS = ["landscape", "square", "portrait", "pin"];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]; // ‰PNG␍␊␚␊

function isPng(bytes) {
  if (bytes.length < PNG_MAGIC.length) return false;
  return PNG_MAGIC.every((b, i) => bytes[i] === b);
}

let failures = 0;

for (const ratio of RATIOS) {
  const url =
    `${base}/og/social/card?ratio=${ratio}&kind=quote` +
    `&text=${encodeURIComponent("Verified condition grading for resale")}` +
    `&product=gradethread`;
  try {
    const res = await fetch(url);
    const buf = new Uint8Array(await res.arrayBuffer());
    const ct = res.headers.get("content-type") || "";
    const ok = res.ok && ct.includes("image/png") && isPng(buf);
    if (ok) {
      console.log(`✓ ${ratio.padEnd(9)} ${buf.length} bytes  ${ct}`);
    } else {
      failures++;
      console.error(
        `✗ ${ratio.padEnd(9)} status=${res.status} ct=${ct} png=${isPng(buf)} bytes=${buf.length}`,
      );
    }
  } catch (err) {
    failures++;
    console.error(`✗ ${ratio.padEnd(9)} fetch failed: ${err.message}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures}/${RATIOS.length} ratio(s) failed against ${base}`);
  process.exit(1);
}
console.log(`\nAll ${RATIOS.length} ratios returned valid PNGs against ${base}`);
