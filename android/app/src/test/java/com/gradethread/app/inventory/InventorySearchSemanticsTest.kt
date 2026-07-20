package com.gradethread.app.inventory

import com.gradethread.app.sync.db.InventoryItemEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1342: how server search combines with local search.
 *
 * The load-bearing distinction is null vs empty. Null means "no server
 * opinion" (query too short, offline, RPC failed); empty means "the server
 * ran and matched nothing". Conflating them would make a failed RPC empty the
 * seller's list, which is the single worst outcome this feature can produce.
 */
class InventorySearchSemanticsTest {

    private fun item(id: String, title: String = "Item", brand: String? = null) =
        InventoryItemEntity(
            id = id, userId = "u", title = title, brand = brand, sku = null, size = null,
            color = null, material = null, status = "sourced", itemCategory = null,
            garmentType = null, garmentCategory = null, itemDescription = null, style = null,
            sourcedBy = null, acquiredDate = null, container = null, compSetJson = null,
            sourceId = null, locationBin = null, consignorId = null, consignmentSplitPct = null,
            acquiredPrice = null, targetPrice = null, listingPrice = null, gradeValue = null,
            gradeLabel = null, certificateUrl = null, gradeReportId = null, disputeStatus = null,
            conditionNotes = null, measurementsJson = null, primaryPhotoUrl = null,
            createdAt = 1L, updatedAt = 1L,
        )

    private fun apply(
        items: List<InventoryItemEntity>,
        query: String,
        serverSearchIds: Set<String>?,
    ) = InventoryFilter.apply(
        items = items,
        stage = InventoryStage.ALL,
        query = query,
        sort = SortOption.NEWEST,
        criteria = InventoryFilterCriteria(),
        serverSearchIds = serverSearchIds,
        nowMillis = 10_000L,
    )

    @Test
    fun aFailedServerSearchLeavesLocalResultsIntact() {
        // null = no server opinion. Local search must still stand.
        val items = listOf(item("1", brand = "Nike"), item("2", brand = "Adidas"))
        assertEquals(listOf("1"), apply(items, "nike", serverSearchIds = null).map { it.id })
    }

    @Test
    fun anEmptyServerResultDoesNotEmptyTheList() {
        // The server ran and matched nothing, but the union is ADDITIVE — a
        // local match still counts.
        val items = listOf(item("1", brand = "Nike"))
        assertEquals(
            listOf("1"),
            apply(items, "nike", serverSearchIds = emptySet()).map { it.id },
        )
    }

    @Test
    fun serverHitsWidenBeyondWhatLocalSearchCanFind() {
        // The whole reason for server FTS: stemming and fuzziness the local
        // substring match cannot do.
        val items = listOf(item("1", title = "Running shoes"))
        assertEquals(
            listOf("1"),
            apply(items, "sneaker", serverSearchIds = setOf("1")).map { it.id },
        )
    }

    @Test
    fun serverSearchIsIgnoredWhenThereIsNoQuery() {
        // With no tokens every item passes; a stale id set must not narrow it.
        val items = listOf(item("1"), item("2"))
        assertEquals(2, apply(items, "", serverSearchIds = setOf("1")).size)
    }

    @Test
    fun theMinimumQueryLengthMatchesTheServiceConstant() {
        // Below this the service returns null rather than calling the RPC.
        assertEquals(2, InventorySearchService.MIN_QUERY_LENGTH)
        assertEquals(100, InventorySearchService.RESULT_LIMIT)
    }

    @Test
    fun theDebounceMatchesIos() {
        assertEquals(250L, InventoryListViewModel.SEARCH_DEBOUNCE_MILLIS)
    }

    @Test
    fun localSearchAloneStillFindsEverythingItShould() {
        // Guards against a regression where server search becomes required.
        val items = listOf(
            item("1", brand = "Patagonia", title = "Synchilla"),
            item("2", brand = "Nike"),
        )
        assertTrue(apply(items, "synchilla", null).map { it.id } == listOf("1"))
        assertTrue(apply(items, "patagonia synchilla", null).map { it.id } == listOf("1"))
    }
}
