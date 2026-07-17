// Throwaway validator for the 00462 seed (US-1983). Checks the two traps that
// nothing else catches: `''` inside a dollar-quoted body (not an escape there —
// the US-1981 lesson) and JSON validity of every dollar-quoted block.
import { readFileSync } from "node:fs";

const path = process.argv[2];
const src = readFileSync(path, "utf8");
let bad = 0;
let ok = 0;

for (const tag of ["j", "json"]) {
  const re = new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`, "g");
  let m;
  while ((m = re.exec(src))) {
    const body = m[1];
    const i = body.indexOf("''");
    if (i !== -1) {
      bad++;
      console.log(
        `!! '' inside $${tag}$: ...${body.slice(Math.max(0, i - 70), i + 70)}...`,
      );
    }
    try {
      JSON.parse(body);
      ok++;
    } catch (e) {
      bad++;
      console.log(`!! JSON parse fail in $${tag}$: ${e.message} | ${body.slice(0, 90)}`);
    }
  }
}
console.log(`JSON blocks parsed OK: ${ok}, violations: ${bad}`);
process.exit(bad ? 1 : 0);
