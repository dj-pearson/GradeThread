# Parked stories

Stories intentionally lifted OUT of the active `prd.json` backlog so the Ralph
loop cannot select and implement them, but preserved here (full JSON) so they
can be restored later. This is NOT the same as `passes: true` — a parked story
is neither done nor accepted; it is on hold by decision.

## Currently parked

### `US-1745.json` — EPIC: Scale the Condition/Value Index into a programmatic-SEO engine
**Parked 2026-07-14.** The epic's goal was to grow the ~54-seed value index into
**thousands** of programmatic `/value/{brand}/{item}/{condition}` pages. For a
young, low-authority domain that is already struggling to get its existing
programmatic pages indexed (~79% of 213 static URLs are templated), adding
thousands more thin templated pages is the wrong move — it invites site-wide
quality suppression and "Discovered / Crawled – currently not indexed."

See `vault/40-growth/seo-indexability.md` for the full rationale. Revisit only
after domain authority grows and GSC shows the existing grading-pSEO segment
indexing at a healthy rate.

## Restore procedure

To put a parked story back into the active backlog:

1. **Stop the Ralph loop first** (`scripts/ralph/stop-ralph.sh`) — editing
   `prd.json` while a loop iteration runs risks a clobbered write.
2. Append the story object from its `US-<id>.json` file back into
   `prd.json`'s `userStories` array (it keeps its original id and priority).
3. Delete the `US-<id>.json` file here and update this README.
4. `node -e "JSON.parse(require('fs').readFileSync('prd.json','utf8'))"` to
   confirm it still parses.
