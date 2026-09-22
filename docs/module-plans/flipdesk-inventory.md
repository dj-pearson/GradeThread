# FlipDesk inventory pipeline (source, catalog, measure, photograph)

Health: **ok**

The edge half of this module is in good shape. The measure, images and phone-capture routes scope every query to the tenant, have rate limits (except one route), and have many unit and tenant-isolation tests. The weak spots are on the browser side: one database function lets a seller write into another seller's account, the photo uploader can publish an original file with its GPS data to the public bucket, offline intake quietly drops data, and the intake, pipeline and sources pages have no tests that check how they behave. The biggest win is closing the get_or_create_source tenant hole and the GPS fallback, since each is a small fix to a real privacy or security gap.

## Actions

### 1. Tenant-scope get_or_create_source (any signed-in user can read and write another seller's sources)

Impact: high | Effort: S | Story: none

**Why:** supabase/migrations/00640_security_definer_body_guards.sql:305-337 is the current body. It is SECURITY DEFINER (runs with owner rights, skips RLS) and its only guard is gt_require_role('authenticated') at :318. It then trusts p_user_id from the caller. It SELECTs and returns another user's source id by name at :323-330 (a way to probe names) and INSERTs a source under that user at :332-334 (a write into a foreign tenant). The browser passes p_user_id itself (src/pages/flipdesk/intake.tsx:394-400, src/components/flipdesk/bulk-intake.tsx:218). vault/20-domain/security-definer-exposure.md:134-137 says this function needs 'auth.uid() is not null plus tenant scoping'. Only the first half was ever shipped. No later migration redefines it (grep finds only 00009 and 00640).

**Steps:**
- Load the migrations skill. Write a new migration that re-emits get_or_create_source with this check after the role guard: allow auth.role()='service_role', or p_user_id = auth.uid(), or public.is_workspace_member_with_role(p_user_id, <the same roles the sources write RLS uses>). Otherwise RAISE 42501.
- Bump EXPECTED_SCHEMA_VERSION in the same commit and add the self-record footer (US-1108).
- Add a --dsn proof script modeled on scripts/check-dispute-report-ownership.mjs. Seed two sellers inside a rolled-back transaction. Show that B calling with A's id gets 42501, B's own call works, and a workspace member of A still works.
- Make the same body check on merge_inventory_items, which sits in the same vault list; that function is outside this module, so hand it to its owner.
- Update vault/20-domain/security-definer-exposure.md in the same commit to say tenant scoping has landed.

### 2. Stop uploading the camera original (with EXIF/GPS) to the public item-photos bucket when compression fails

Impact: high | Effort: S | Story: none

**Why:** src/lib/item-photo-upload.ts:66-68 sets body = the original file. It is replaced by the canvas output (which strips metadata) only when compressImage succeeds and main.blob.size > 0 (:89-93). If compressImage throws, the catch at :111-118 only logs in DEV and falls through, and :126-128 uploads the untouched original to item-photos, the one public bucket (CLAUDE.md US-276). The same core is used by intake (intake.tsx:500-507) and the item page. The server-side stripImageMetadata never runs on this path because the browser writes to storage directly. Also, if the item_photos insert fails at :160-177, the object already uploaded at :126 is left behind with no row. There is no unit test for this file; the only coverage is a source-string scan in src/test/intake-capture-and-guard.test.ts.

**Steps:**
- When compression fails or yields an empty blob, do not upload the original. Either re-encode through a minimal canvas pass, strip EXIF/XMP in JS for JPEG, or throw a clear 'could not prepare this photo' error the caller already reports as a failed upload.
- If the item_photos insert fails, remove the storage object (and the thumbnail) that were just uploaded before rethrowing.
- Add src/lib/__tests__/item-photo-upload.test.ts. Mock compressImage to throw and assert storage.upload never receives the original File. Mock the insert to fail and assert remove() is called.
- Sabotage-check: revert the fix and confirm the new test goes red.

### 3. Harden the public phone-capture upload: real insert errors reported as success, racy caps, no rate limit

Impact: medium | Effort: S | Story: none (related: US-3185 phone capture batches)

**Why:** services/edge-functions/src/routes/flipdesk-phone-capture.ts:457-461 treats ANY insert error as a duplicate and returns ok:true. A failed insert (not a unique-key clash) tells the phone the photo saved, but no row exists, so the desktop never sees the photo and the staged object is orphaned. :465-470 writes photo_count: session.photo_count + 1 from a value read earlier. Two uploads at once both pass refuseCapture (:415, lib/phone-capture.ts:149-157) and one increment is lost, so the 40-photo / 200 MB caps can be exceeded. /api/flipdesk/capture/s/* is public by design (main.ts:665-669), but unlike every other upload route it has no rateLimiter entry. main.ts mounts the route at :1500, and grep finds no limiter for that path.

**Steps:**
- Check insErr.code === '23505' for the duplicate branch. Any other error returns 502 and removes the object just uploaded at :428.
- Replace the read-modify-write with an atomic conditional update or a small RPC that increments and checks the cap in one statement (photo_count < CAPTURE_MAX_PHOTOS AND bytes_total + n <= CAPTURE_MAX_BYTES). If the row does not update, the upload counts as refused.
- Add rateLimiter(..., 'flipdesk-capture-public', { methods: ['POST'] }) for /api/flipdesk/capture/s/*. Size it above one honest phone burst, which is about 40 photos.
- Add phone-capture_test.ts cases for: a non-23505 insert error returning non-ok, and the cap holding under two concurrent uploads (a stubbed client is enough).

### 4. Fix offline intake: a new source always fails offline, and staged photos are silently dropped

Impact: medium | Effort: M | Story: none

**Why:** src/pages/flipdesk/intake.tsx:387-403 calls the get_or_create_source RPC BEFORE the offline check at :459. Offline with 'new source' selected, that fetch throws, and the catch at :565-567 shows 'Save failed'. The offline queue cannot take that case at all. When the item does queue offline, :478 clears stagedPhotos and :462-464 shows 'Saved offline, it will sync', but enqueueIntake (src/lib/offline-queue.ts:61-68) stores only the insert payload. The photos are gone and the seller is told the save worked. Intake is the thrift-store floor surface, which is exactly where the signal drops.

**Steps:**
- Move the offline branch ahead of source resolution. Queue the new source NAME with the payload, and have flushIntakeQueue resolve it (get_or_create_source) at replay.
- Either persist staged photo Blobs in the same IndexedDB record and upload them after the upsert on flush, or keep the photos staged and say plainly 'Item saved offline; photos were not saved, add them when you're back online'.
- Pull the save planning into a pure function (like quick-edit-plan.ts) and unit-test offline+new-source and offline+photos.

### 5. Make the board's Photographed rule match the auto-advance rule (front+back required)

Impact: medium | Effort: S | Story: US-2304 (related, not a duplicate)

**Why:** src/lib/pipeline-rules.ts:23-78 (validateStatusChange, used by drag and batch-advance in pipeline.tsx:377 and :452) has checks for measured, listed and shipped but none for photographed. So a card with zero photos can be dragged into Photographed. The auto-advance rule in src/lib/workflow.ts:62 earns Photographed only when has_required_photos, which is front AND back (supabase/migrations/00769_inventory_items_floor_price.sql:119-124). From Photographed, batchMoveNext routes cards straight into bulk grading (pipeline.tsx:427-437). That feeds the paid, doomed-to-abstain grading path US-2304 describes. The skip-ahead block at pipeline-rules.ts:69-76 returns null on both branches and is dead code that claims to 'flag' big jumps.

**Steps:**
- In validateStatusChange, when next is photographed or later (by rank), require item.has_required_photos. Return 'Add a front and back photo before moving to Photographed.'
- Delete the dead skip-ahead block, or make it return a confirm reason the board actually shows.
- Extend src/lib/__tests__/flipdesk-lifecycle.test.ts: photographed with has_required_photos=false is refused, true is allowed.
- Coordinate with US-2304 so the label-photo requirement is decided in one place and not two.

### 6. Add behavior tests for the pipeline board, intake and sources pages

Impact: medium | Effort: M | Story: none

**Why:** No test imports src/pages/flipdesk/pipeline.tsx, intake.tsx, sources.tsx, item.tsx or measure-card.tsx (checked by grep across *.test.*). The only intake coverage is src/test/intake-capture-and-guard.test.ts, which checks for strings (expect(src).toContain('<IntakePhotoStager')). Real logic sits untested inside these components: optimistic drag with per-item rollback (pipeline.tsx:383-416), grading-bound peel-off (:427-437), intake source resolution and garment derivation (intake.tsx:385-451), and the photo partial-failure toast (:514-521). Compare listings and inventory, which have dozens of __tests__ files.

**Steps:**
- Pull pure planners out of pipeline.tsx (batch plan: toMove vs gradingBound vs refused) and intake.tsx (buildIntakeInsert) and unit-test them.
- Add one RTL test for handleDragEnd: a failed update rolls back only the dragged card and leaves a second card's concurrent change intact (the US-1633 claim).
- Add one RTL test for sources delete: the warning names the linked item count.

### 7. Sources page: count items per source in SQL instead of pulling every inventory row

Impact: low | Effort: S | Story: none

**Why:** src/pages/flipdesk/sources.tsx:98-106 runs supabase.from('inventory_items').select('source_id') with no range and no paging, then counts on the client (:110-117). vault/10-ops/postgrest-row-cap.md says every read must 'page until empty, count without rows, or aggregate in SQL'. The binding limit in prod is an 8s statement_timeout. For a large catalog this pulls every row just to show a count. If a row cap is ever set, the delete dialog (:330-342) would under-report how many items get unlinked.

**Steps:**
- Replace it with an aggregate: a view or RPC returning source_id plus count(*) for the caller's workspace, or a head:true count per visible source.
- Keep the delete dialog reading that count, and add a test that the count comes from the aggregate.

### 8. Board polish: batch advance in one write per stage, keep filters on '+N more'

Impact: low | Effort: S | Story: none

**Why:** batchMoveNext does one sequential UPDATE per selected card (src/pages/flipdesk/pipeline.tsx:441-476), so 200 selected cards means 200 round trips while the dialog spins. The '+N more' link at :838-840 goes to /items?status=X and drops the active ?q=, brand, category, source and advanced filter, so the list shown does not match the card count the seller just saw. The column badge (:812-818) shows the unfiltered statusCounts even while filters are applied.

**Steps:**
- Validate each card as now, group the passing ids by target status, and send one .update({status}).in('id', ids) per group. Report per-group errors.
- Carry the current search params (q, filter, brand, category, source) into the '+N more' link.
- When any filter is active, show the filtered column length in the badge (or 'x of y').

## Risks

- The get_or_create_source hole is live in prod for any signed-in account. It lets someone plant sources in another seller's account and probe that seller's source names. Treat it as a security fix, not a backlog item.
- The GPS fallback only fires when browser compression fails, so it is rare. But the result is a seller's home location sitting in a public bucket, and eBay may copy the photo out. There is no server step behind it to catch the leak.
- Many rules live in two places: board rules (pipeline-rules.ts) vs auto-advance (workflow.ts), and web vs iOS/Android intake. Changing one without the other is how the Photographed gap appeared. Check the native apps for the same gate before calling the fix done.
- Existing photo cleanup stories (US-3431 missing objects, US-3426 staged orphan sweep) delete seller photos. The orphan-on-insert-failure fix above adds a new deletion path, so give it the same care: delete only the object this request just uploaded.
- Measurement accuracy is still unproven: US-1582 (operator golden set) is open, and imagescript rotate cannot be checked under the cloud Deno substitute, so auto-upright results in a cloud run are unmeasured.
- Open stories in this area that should not be duplicated: US-2304 (label photo vs grading), US-2231 (MeasureCard page dead-ends), US-1582 (measure golden set), US-3185 (phone capture batches), US-3431 / US-3426 (photo object repair and sweep), US-3467 (inventory quick-edit), US-2738 (cross-post photo confirm), US-2812 / US-2813 (measurement catalogs and eBay aspects).
