const fs = require("fs");
const p = JSON.parse(fs.readFileSync("prd.json", "utf8"));
const s = p.userStories.find((x) => x.id === "US-1998");
console.log("TITLE: " + s.title + "\n");
console.log("DESC: " + s.description + "\n");
console.log("ACs:");
(s.acceptanceCriteria || []).forEach((a, i) => console.log("  " + (i + 1) + ". " + a));
