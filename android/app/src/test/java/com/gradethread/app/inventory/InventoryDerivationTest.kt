package com.gradethread.app.inventory

import com.gradethread.app.sync.db.InventoryItemEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1342: the inventory derivation pipeline and its memo contract.
 *
 * Ported from the iOS `InventoryDerivationTests` — the memo assertions in
 * particular, since "the value was right" is a different claim from "it
 * didn't recompute", and only the second is what AC #2 asks for.
 */
class InventoryDerivationTest {

    private fun item(
        id: String,
        status: String = "sourced",
        title: String = "Item",
        brand: String? = null,
        size: String? = null,
        color: String? = null,
        sku: String? = null,
        locationBin: String? = null,
        sourceId: String? = null,
        itemCategory: String? = null,
        grade: Double? = null,
        acquired: Double? = null,
        target: Double? = null,
        listing: Double? = null,
        createdAt: Long = 1_000L,
        updatedAt: Long = 1_000L,
    ) = InventoryItemEntity(
        id = id, userId = "u", title = title, brand = brand, sku = sku, size = size,
        color = color, material = null, status = status, itemCategory = itemCategory,
        garmentType = null, garmentCategory = null, itemDescription = null, style = null,
        sourcedBy = null, acquiredDate = null, container = null, compSetJson = null,
        sourceId = sourceId, locationBin = locationBin, consignorId = null,
        consignmentSplitPct = null, acquiredPrice = acquired, targetPrice = target,
        listingPrice = listing, gradeValue = grade, gradeLabel = null, certificateUrl = null,
        gradeReportId = null, disputeStatus = null, conditionNotes = null,
        measurementsJson = null, primaryPhotoUrl = null, createdAt = createdAt,
        updatedAt = updatedAt,
    )

    // ── stages ───────────────────────────────────────────────────────────

    @Test
    fun stagesMapToTheirStatuses() {
        assertTrue(InventoryStage.UNLISTED.matches("photographed"))
        assertTrue(InventoryStage.UNLISTED.matches("drafted"))
        // With the web: an item mid-grade is still unlisted, not tabless.
        assertTrue(InventoryStage.UNLISTED.matches("grading"))
        assertTrue(UnlistedFilter.NEEDS_DRAFT.matches("photographed"))
        assertFalse(UnlistedFilter.NEEDS_DRAFT.matches("drafted"))
        assertTrue(UnlistedFilter.DRAFTED.matches("drafted"))
        assertTrue(InventoryStage.ACTIVE.matches("listed"))
        assertTrue(InventoryStage.SHIPPED.matches("completed"))
        assertFalse(InventoryStage.ACTIVE.matches("sold"))
    }

    @Test
    fun allAdmitsEveryKnownStatus() {
        for (status in InventoryStage.allKnownStatuses) {
            assertTrue("ALL rejected $status", InventoryStage.ALL.matches(status))
        }
    }

    @Test
    fun everyPipelineStatusHasExactlyOneSpecificTab() {
        // This used to pin the opposite for `grading`: carried over from iOS, an
        // item mid-grading vanished from every tab but All, and the test called
        // the surprise deliberate. With UNLISTED (2026-09-02, matching the web)
        // it belongs there, so the only statuses without a tab of their own are
        // the off-pipeline ones.
        val specific = InventoryStage.userFacing - InventoryStage.ALL
        for (status in InventoryStage.allKnownStatuses - InventoryStage.statusesWithoutASpecificTab) {
            assertEquals(status, 1, specific.count { it.matches(status) })
        }
        for (status in InventoryStage.statusesWithoutASpecificTab) {
            assertTrue(status, specific.none { it.matches(status) })
            assertTrue(status, InventoryStage.ALL.matches(status))
        }
    }

    @Test
    fun thereIsNoUnsoldStage() {
        // The AC names an "unsold" tab; iOS has no such stage. Asserted so
        // the divergence is visible rather than quietly assumed. Six since
        // To List and Drafts became UNLISTED.
        assertTrue(InventoryStage.entries.none { it.wire == "unsold" })
        assertEquals(6, InventoryStage.userFacing.size)
    }

    @Test
    fun stageCountsCountAnItemInBothAllAndItsStage() {
        val d = InventoryDerivation()
        val counts = d.stageCounts(listOf(item("1", status = "listed")))
        assertEquals(1, counts[InventoryStage.ALL])
        assertEquals(1, counts[InventoryStage.ACTIVE])
        assertEquals(0, counts[InventoryStage.SOLD])
    }

    // ── search ───────────────────────────────────────────────────────────

    @Test
    fun searchTokenizesOnNonAlphanumerics() {
        assertEquals(listOf("nike", "air", "max"), InventoryFilter.searchTokens("Nike, Air-Max!"))
    }

    @Test
    fun searchIsSubstringNotTokenEquality() {
        val items = listOf(item("1", brand = "Nike"))
        assertEquals(1, apply(items, query = "nik").size)
    }

    @Test
    fun allTokensMustMatch() {
        val items = listOf(item("1", title = "Fleece", brand = "Patagonia"))
        assertEquals(1, apply(items, query = "patagonia fleece").size)
        assertEquals(0, apply(items, query = "patagonia jacket").size)
    }

    @Test
    fun searchCoversTheSecondaryFields() {
        val items = listOf(item("1", locationBin = "A-12"))
        assertEquals(1, apply(items, query = "a-12").size)
    }

    @Test
    fun aServerHitBypassesTheLocalTextMatch() {
        val items = listOf(item("1", title = "Nothing relevant"))
        assertEquals(
            1,
            apply(items, query = "zzz", serverSearchIds = setOf("1")).size,
        )
    }

    @Test
    fun aServerHitCannotResurrectAnItemExcludedByStage() {
        // The union applies inside the search step only — stage and facets
        // have already had their say.
        val items = listOf(item("1", status = "sold"))
        assertEquals(
            0,
            apply(items, stage = InventoryStage.ACTIVE, query = "zzz", serverSearchIds = setOf("1")).size,
        )
    }

    @Test
    fun aServerHitCannotResurrectAnItemExcludedByAFacet() {
        val items = listOf(item("1", brand = "Nike"))
        assertEquals(
            0,
            apply(
                items,
                query = "zzz",
                criteria = InventoryFilterCriteria(brands = setOf("Adidas")),
                serverSearchIds = setOf("1"),
            ).size,
        )
    }

    // ── facets ───────────────────────────────────────────────────────────

    @Test
    fun facetsCombineOrWithinAndAndAcross() {
        val items = listOf(
            item("1", brand = "Nike", size = "M"),
            item("2", brand = "Adidas", size = "M"),
            item("3", brand = "Nike", size = "L"),
        )
        // OR within brand.
        assertEquals(
            3,
            apply(items, criteria = InventoryFilterCriteria(brands = setOf("Nike", "Adidas"))).size,
        )
        // AND across brand + size.
        assertEquals(
            1,
            apply(
                items,
                criteria = InventoryFilterCriteria(brands = setOf("Nike"), sizes = setOf("M")),
            ).size,
        )
    }

    @Test
    fun gradedOnlyDropsUngradedItems() {
        val items = listOf(item("1", grade = 8.5), item("2"))
        assertEquals(
            listOf("1"),
            apply(items, criteria = InventoryFilterCriteria(gradedOnly = true)).map { it.id },
        )
    }

    @Test
    fun minGradeImpliesGraded() {
        val items = listOf(item("1", grade = 6.0), item("2"))
        assertEquals(
            0,
            apply(items, criteria = InventoryFilterCriteria(minGrade = 7.0)).size,
        )
    }

    @Test
    fun priceUsesTheMostSpecificValue() {
        // listing beats target beats cost.
        assertEquals(
            30.0,
            InventoryFilter.effectivePrice(
                item("1", acquired = 10.0, target = 20.0, listing = 30.0),
            ),
        )
        assertEquals(20.0, InventoryFilter.effectivePrice(item("1", acquired = 10.0, target = 20.0)))
        assertEquals(10.0, InventoryFilter.effectivePrice(item("1", acquired = 10.0)))
    }

    @Test
    fun aCeilingOnlyBandKeepsUnpricedItems() {
        // US-1247: an unpriced item might well be cheap.
        val items = listOf(item("1"))
        assertEquals(1, apply(items, criteria = InventoryFilterCriteria(maxPrice = 50.0)).size)
    }

    @Test
    fun anyFloorDropsUnpricedItems() {
        // ...but it can't be shown to clear a minimum.
        val items = listOf(item("1"))
        assertEquals(0, apply(items, criteria = InventoryFilterCriteria(minPrice = 10.0)).size)
    }

    @Test
    fun photoPresenceUsesRowsNotTheCoverUrl() {
        // US-994: the denormalized cover lags the real photo set.
        val items = listOf(item("1"), item("2"))
        assertEquals(
            listOf("1"),
            apply(
                items,
                criteria = InventoryFilterCriteria(photoState = PhotoState.WITH_PHOTO),
                photoItemIds = setOf("1"),
            ).map { it.id },
        )
        assertEquals(
            listOf("2"),
            apply(
                items,
                criteria = InventoryFilterCriteria(photoState = PhotoState.MISSING_PHOTO),
                photoItemIds = setOf("1"),
            ).map { it.id },
        )
    }

    @Test
    fun activeCountCountsFacetsNotSelections() {
        val criteria = InventoryFilterCriteria(
            brands = setOf("Nike", "Adidas", "Puma"),
            minPrice = 10.0,
            maxPrice = 50.0,
        )
        // Three brands is one thing to undo; a price band is one more.
        assertEquals(2, criteria.activeCount)
    }

    @Test
    fun facetValuesAreRankedByCountThenLabel() {
        val items = listOf(
            item("1", brand = "Adidas"),
            item("2", brand = "Nike"),
            item("3", brand = "Nike"),
        )
        val facets = InventoryFacetsBuilder.derive(items)
        assertEquals(listOf("Nike", "Adidas"), facets.brands.map { it.value })
    }

    @Test
    fun blankFacetValuesAreDropped() {
        val facets = InventoryFacetsBuilder.derive(listOf(item("1", brand = "   ")))
        assertTrue(facets.brands.isEmpty())
    }

    @Test
    fun sizesSortInWearingOrderNotAlphabetical() {
        val items = listOf(
            item("1", size = "L"),
            item("2", size = "S"),
            item("3", size = "XL"),
            item("4", size = "M"),
        )
        val facets = InventoryFacetsBuilder.derive(items)
        assertEquals(listOf("S", "M", "L", "XL"), facets.sizes.map { it.value })
    }

    @Test
    fun sourceFacetsAreKeyedByIdButLabelledByName() {
        val items = listOf(item("1", sourceId = "src-1"))
        val facets = InventoryFacetsBuilder.derive(items, mapOf("src-1" to "Goodwill"))
        assertEquals("src-1", facets.sources.single().value)
        assertEquals("Goodwill", facets.sources.single().label)
    }

    @Test
    fun aDegeneratePriceRangeIsWidened() {
        // A zero-width range breaks a slider.
        val facets = InventoryFacetsBuilder.derive(listOf(item("1", acquired = 10.0)))
        assertEquals(10.0, facets.priceRange?.start)
        assertEquals(11.0, facets.priceRange?.endInclusive)
    }

    // ── sorts ────────────────────────────────────────────────────────────

    @Test
    fun highestGradeSinksUngradedItems() {
        val items = listOf(item("1"), item("2", grade = 9.0), item("3", grade = 5.0))
        assertEquals(
            listOf("2", "3", "1"),
            apply(items, sort = SortOption.HIGHEST_GRADE).map { it.id },
        )
    }

    @Test
    fun roiIsNullForZeroCost() {
        // A zero-cost item sorts as missing, not as infinite ROI.
        assertNull(SortOption.roi(target = 50.0, cost = 0.0))
        assertEquals(1.0, SortOption.roi(target = 20.0, cost = 10.0))
    }

    @Test
    fun bestRoiFallsBackToNewestForTiedNulls() {
        val items = listOf(item("1", createdAt = 1), item("2", createdAt = 2))
        assertEquals(listOf("2", "1"), apply(items, sort = SortOption.BEST_ROI).map { it.id })
    }

    @Test
    fun skuSortsNaturallyNotLexically() {
        val items = listOf(item("1", sku = "SKU-10"), item("2", sku = "SKU-9"))
        // Lexical order would put SKU-10 first.
        assertEquals(listOf("2", "1"), apply(items, sort = SortOption.SKU_NATURAL).map { it.id })
    }

    @Test
    fun naturalCompareHandlesPureNumbersAndPrefixes() {
        assertTrue(SortOption.naturalCompare("a2", "a10") < 0)
        assertTrue(SortOption.naturalCompare("abc", "abcd") < 0)
        assertEquals(0, SortOption.naturalCompare("A1", "a1"))
    }

    @Test
    fun tiesBreakDeterministicallyById() {
        // Swift's sort isn't stable and Kotlin's is, so ties are pinned
        // explicitly or the two clients show different orders.
        val items = listOf(item("b", createdAt = 5), item("a", createdAt = 5))
        assertEquals(listOf("a", "b"), apply(items, sort = SortOption.NEWEST).map { it.id })
    }

    // ── the memo contract (AC #2) ────────────────────────────────────────

    @Test
    fun repeatedIdenticalReadsRunTheFilterOnce() {
        val d = InventoryDerivation()
        val items = listOf(item("1"))
        repeat(5) { d.filtered(items, InventoryStage.ALL, "", SortOption.NEWEST, InventoryFilterCriteria()) }
        assertEquals(1, d.filterPassCount)
    }

    @Test
    fun unrelatedStateChangesDoNotInvalidateTheFilterMemo() {
        // The whole point: opening a sheet, toggling select mode or showing a
        // refresh banner all recompose the screen but touch no filter input,
        // so the key is byte-stable and the pass never re-runs.
        val d = InventoryDerivation()
        val items = listOf(item("1"), item("2"))
        val read = {
            d.filtered(items, InventoryStage.ALL, "", SortOption.NEWEST, InventoryFilterCriteria())
        }
        read()
        repeat(20) { read() } // stand-in for 20 unrelated recompositions
        assertEquals(1, d.filterPassCount)
    }

    @Test
    fun eachFilterInputChangeInvalidatesExactlyOnce() {
        val d = InventoryDerivation()
        val items = listOf(item("1"))
        d.filtered(items, InventoryStage.ALL, "", SortOption.NEWEST, InventoryFilterCriteria())
        assertEquals(1, d.filterPassCount)
        d.filtered(items, InventoryStage.SOLD, "", SortOption.NEWEST, InventoryFilterCriteria())
        assertEquals(2, d.filterPassCount)
        d.filtered(items, InventoryStage.SOLD, "nike", SortOption.NEWEST, InventoryFilterCriteria())
        assertEquals(3, d.filterPassCount)
        d.filtered(items, InventoryStage.SOLD, "nike", SortOption.OLDEST, InventoryFilterCriteria())
        assertEquals(4, d.filterPassCount)
        d.filtered(
            items,
            InventoryStage.SOLD,
            "nike",
            SortOption.OLDEST,
            InventoryFilterCriteria(gradedOnly = true),
        )
        assertEquals(5, d.filterPassCount)
    }

    @Test
    fun editingAnItemInvalidatesTheMemo() {
        val d = InventoryDerivation()
        d.filtered(
            listOf(item("1", updatedAt = 1)),
            InventoryStage.ALL,
            "",
            SortOption.NEWEST,
            InventoryFilterCriteria(),
        )
        d.filtered(
            listOf(item("1", updatedAt = 2)),
            InventoryStage.ALL,
            "",
            SortOption.NEWEST,
            InventoryFilterCriteria(),
        )
        assertEquals(2, d.filterPassCount)
    }

    @Test
    fun signatureChangesWhenAnItemIsAddedOrEdited() {
        val base = listOf(item("1", updatedAt = 1))
        assertEquals(
            InventoryDerivation.itemsSignature(base),
            InventoryDerivation.itemsSignature(listOf(item("1", updatedAt = 1))),
        )
        assertTrue(
            InventoryDerivation.itemsSignature(base) !=
                InventoryDerivation.itemsSignature(listOf(item("1", updatedAt = 2))),
        )
        assertTrue(
            InventoryDerivation.itemsSignature(base) !=
                InventoryDerivation.itemsSignature(base + item("2")),
        )
    }

    @Test
    fun aSourceRenameRefreshesFacetsWithoutAnyItemChanging() {
        val d = InventoryDerivation()
        val items = listOf(item("1", sourceId = "src-1"))
        d.facets(items, mapOf("src-1" to "Goodwill"))
        assertEquals(1, d.facetsPassCount)
        d.facets(items, mapOf("src-1" to "Salvation Army"))
        assertEquals(2, d.facetsPassCount)
    }

    @Test
    fun stageCountsMemoIsIndependentOfTheFilterMemo() {
        val d = InventoryDerivation()
        val items = listOf(item("1"))
        d.stageCounts(items)
        // Changing a filter input must not re-run the counts.
        d.filtered(items, InventoryStage.SOLD, "x", SortOption.OLDEST, InventoryFilterCriteria())
        d.stageCounts(items)
        assertEquals(1, d.stageCountsPassCount)
    }

    // ── board ────────────────────────────────────────────────────────────

    @Test
    fun boardHasThirteenColumnsInPipelineOrder() {
        assertEquals(13, PipelineBoard.columns.size)
        assertEquals("sourced", PipelineBoard.statusOrder.first())
        assertEquals("returned", PipelineBoard.statusOrder.last())
    }

    @Test
    fun groupingPreSeedsEveryColumnSoEmptiesRender() {
        val grouped = PipelineBoard.group(listOf(item("1", status = "listed"))) { it.status }
        assertEquals(13, grouped.size)
        assertEquals(listOf("1"), grouped["listed"]?.map { it.id })
        assertTrue(grouped["sourced"]?.isEmpty() == true)
    }

    @Test
    fun acquiredItemsAppearInTheTabButNotOnTheBoard() {
        // Carried over from iOS; pinned because it looks like data loss.
        assertTrue(InventoryStage.UNLISTED.matches("acquired"))
        assertFalse("acquired" in PipelineBoard.columnStatuses)
        val grouped = PipelineBoard.group(listOf(item("1", status = "acquired"))) { it.status }
        assertTrue(grouped.values.all { it.isEmpty() })
    }

    @Test
    fun moveToTheSameColumnIsANoOp() {
        assertNull(PipelineBoard.planMove("listed", "listed"))
    }

    @Test
    fun moveToANonColumnIsRejected() {
        assertNull(PipelineBoard.planMove("listed", "archived"))
    }

    @Test
    fun backwardsMovesAreAllowed() {
        // Pulling a listing back to re-photograph is legitimate.
        assertEquals(
            PipelineBoard.Move("listed", "photographed"),
            PipelineBoard.planMove("listed", "photographed"),
        )
    }

    // ── helper ───────────────────────────────────────────────────────────

    private fun apply(
        items: List<InventoryItemEntity>,
        stage: InventoryStage = InventoryStage.ALL,
        query: String = "",
        sort: SortOption = SortOption.NEWEST,
        criteria: InventoryFilterCriteria = InventoryFilterCriteria(),
        photoItemIds: Set<String>? = null,
        serverSearchIds: Set<String>? = null,
    ) = InventoryFilter.apply(
        items,
        stage,
        query,
        sort,
        criteria,
        photoItemIds,
        serverSearchIds,
        nowMillis = 10_000_000L,
    )
}
