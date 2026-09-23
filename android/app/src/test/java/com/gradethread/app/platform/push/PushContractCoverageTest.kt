package com.gradethread.app.platform.push

import com.gradethread.app.platform.deeplink.DeepLinkRoute
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * US-3449: every category the edge sends is one Android knows.
 *
 * Reads `contracts/push-contract.json`, which the edge GENERATES from its own
 * senders (services/edge-functions/scripts/generate-push-contract.ts) and
 * fails its own test when stale. iOS reads the same file in
 * PushCategoryCoverageTests. Android used to read nothing, and eight
 * categories (the post-order family, the offer reply and marketing) arrived
 * as unknown ids: the muted UPDATES channel and no tap route.
 */
class PushContractCoverageTest {

    /** Gradle runs unit tests from `android/app`, so the repo root is two up. */
    private val contract = File("../../contracts/push-contract.json")

    private val sentByEdge: List<String> by lazy {
        Json.parseToJsonElement(contract.readText())
            .jsonObject.getValue("categories").jsonArray
            .map { it.jsonObject.getValue("id").jsonPrimitive.content }
    }

    /**
     * Categories whose tap deliberately just opens the app. Same set, same
     * reason as iOS's `noDestination`: a growth campaign is about the product,
     * not about a row.
     */
    private val noDestination = setOf("marketing")

    @Test
    fun `the contract is read, not skipped`() {
        // A wrong path must not pass as "nothing unknown".
        assertTrue(contract.absolutePath, contract.isFile)
        assertTrue("only ${sentByEdge.size} categories read", sentByEdge.size >= 10)
    }

    @Test
    fun `every category the edge sends is known to Android`() {
        val unknown = sentByEdge.filter { PushCategory.of(it) == null }
        assertEquals(
            "the edge sends these and Android does not recognise them, so they land on the " +
                "muted UPDATES channel and the tap goes nowhere",
            emptyList<String>(),
            unknown,
        )
    }

    @Test
    fun `every category the edge sends routes somewhere`() {
        sentByEdge.filterNot { it in noDestination }.forEach { id ->
            val category = PushCategory.of(id) ?: return@forEach
            assertNotNull("$id has no tap route", category.route(emptyMap()))
        }
    }

    @Test
    fun `the pushes that start an eBay clock are urgent`() {
        // Missing one of these costs a defect or a lost case, so they do not
        // sit on a channel sellers mute.
        listOf("case.deadline", "dispute.opened", "return.opened").forEach { id ->
            assertEquals(id, PushChannel.URGENT, PushCategory.of(id)?.channel)
        }
    }

    @Test
    fun `the post-order family opens the eBay cases screen`() {
        listOf(
            "return.opened",
            "inquiry.opened",
            "case.opened",
            "case.deadline",
            "cancellation.requested",
            "dispute.opened",
        ).forEach { id ->
            assertEquals(id, DeepLinkRoute.EbayCases, PushCategory.of(id)?.route(emptyMap()))
        }
    }

    @Test
    fun `an offer reply opens the same inbox as the offer`() {
        assertEquals(
            DeepLinkRoute.NegotiationInbox("i1"),
            PushCategory.OFFER_RESPONDED.route(mapOf("inventory_item_id" to "i1")),
        )
        assertEquals(PushChannel.SELLING, PushCategory.OFFER_RESPONDED.channel)
    }

    @Test
    fun `marketing is quiet and opens the app`() {
        assertEquals(PushChannel.UPDATES, PushCategory.MARKETING.channel)
        assertNull(PushCategory.MARKETING.route(emptyMap()))
        assertTrue(PushCategory.MARKETING.actions.isEmpty())
    }
}
