import { readFileSync, writeFileSync } from "node:fs";
const f = "_labels4.mjs";
let s = readFileSync(f, "utf8").split("\r\n").join("\n");
const R = [
  [
    '    `                value={submitUrl}`,\n    `                aria-label="URL to submit to IndexNow"\n                value={submitUrl}`,',
    '    `            <Input\n              type="url"`,\n    `            <Input\n              aria-label="URL to submit to IndexNow"\n              type="url"`,',
  ],
  [
    '    `              placeholder="Title…"`,\n    `              aria-label="Post title"\n              placeholder="Title…"`,',
    '    `            placeholder="Title…"`,\n    `            aria-label="Post title"\n            placeholder="Title…"`,',
  ],
  [
    '    `                value={search}`,\n    `                aria-label="Search active listings by title"\n                value={search}`,',
    '    `                placeholder="Search title…"`,\n    `                aria-label="Search active listings by title"\n                placeholder="Search title…"`,',
  ],
];
for (const [a, b] of R) {
  if (!s.includes(a)) { console.error("MISS " + JSON.stringify(a.slice(0, 50))); process.exit(1); }
  s = s.replace(a, b);
}
writeFileSync(f, s);
console.log("ok");
