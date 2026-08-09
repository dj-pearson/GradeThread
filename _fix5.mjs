import { readFileSync, writeFileSync } from "node:fs";
const f = "_labels4.mjs";
let s = readFileSync(f, "utf8").split("\r\n").join("\n");
const R = [
  [
    '[`            <Textarea\n              value={editJson}`, `            <Textarea\n              id="bk-fields"\n              value={editJson}`]',
    '[`            <Textarea\n              className="min-h-[280px] font-mono text-xs"`, `            <Textarea\n              id="bk-fields"\n              className="min-h-[280px] font-mono text-xs"`]',
  ],
  [
    '[`              <SelectTrigger>\n`, `              <SelectTrigger id="bulk-operation">\n`]',
    '[`                <SelectTrigger>\n`, `                <SelectTrigger id="bulk-operation">\n`]',
  ],
  [
    '[`                <Input\n                  value={draft.targetPrice}`, `                <Input\n                  id="prep-target-price"\n                  value={draft.targetPrice}`]',
    '[`            <Input\n              type="number"\n              value={draft.targetPrice}`, `            <Input\n              id="prep-target-price"\n              type="number"\n              value={draft.targetPrice}`]',
  ],
];
for (const [a, b] of R) {
  if (!s.includes(a)) { console.error("MISS " + JSON.stringify(a.slice(0, 60))); process.exit(1); }
  s = s.replace(a, b);
}
writeFileSync(f, s);
console.log("ok");
