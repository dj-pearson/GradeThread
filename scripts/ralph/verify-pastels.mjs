import fs from "node:fs";
import path from "node:path";
function walk(d, a) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    const s = fs.statSync(p);
    if (s.isDirectory()) {
      if (f === "ui") continue;
      walk(p, a);
    } else if ([".tsx", ".ts"].includes(path.extname(f))) a.push(p);
  }
  return a;
}
const files = walk("src", []);
const fams =
  "red|green|blue|yellow|amber|emerald|orange|purple|indigo|pink|rose|sky|teal|cyan|lime|violet|fuchsia";
const tok = new RegExp(
  `(?:^|[\\s"'\`])((?:[a-z-]+:)*)(bg-(?:${fams})-(?:50|100|200)|text-(?:${fams})-(?:600|700|800|900)|border-(?:${fams})-(?:100|200|300))(?=[\\s"'\`/]|$)`,
  "g"
);
const hits = [];
for (const f of files) {
  const lines = fs.readFileSync(f, "utf8").split("\n");
  lines.forEach((ln, i) => {
    let m;
    tok.lastIndex = 0;
    while ((m = tok.exec(ln))) {
      const prefix = m[1];
      const base = m[2];
      const mm = base.match(/^(bg|text|border)-([a-z]+)-(\d+)$/);
      tok.lastIndex = m.index + 1;
      if (!mm) continue;
      const re = new RegExp(`dark:${prefix}${mm[1]}-${mm[2]}-`);
      if (!re.test(ln))
        hits.push(`${f.replace(/\\/g, "/")}:${i + 1}  ${prefix}${base}`);
    }
  });
}
console.log("Remaining light pastels w/o same-line dark counterpart:", hits.length);
console.log(hits.join("\n"));
