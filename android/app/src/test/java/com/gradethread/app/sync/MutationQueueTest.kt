package com.gradethread.app.sync

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.PendingMutationEntity
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.IOException

/**
 * US-1319: the replay invariants — create-before-edit deferral with same-pass
 * unblock (US-1208), the blocked-target hold (US-1496), stuck skipping,
 * terminal-vs-transient bookkeeping, and enqueue gating.
 */
@RunWith(RobolectricTestRunner::class)
class MutationQueueTest {

    private lateinit var db: GradeThreadDb
    private lateinit var queue: OfflineMutationQueue
    private var now = 0L

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        db = Room.inMemoryDatabaseBuilder(context, GradeThreadDb::class.java)
            .allowMainThreadQueries()
            .build()
        now = 0L
        queue = OfflineMutationQueue(db, clock = { now.also { now += 1 } })
    }

    @After
    fun tearDown() {
        db.close()
    }

    private suspend fun executedKindsDrain(
        failing: Map<String, Throwable> = emptyMap(),
    ): Pair<List<String>, OfflineMutationQueue.DrainResult> {
        val executed = mutableListOf<String>()
        val result = queue.drain { mutation ->
            failing[mutation.targetId]?.let { throw it }
            executed += "${mutation.kind}:${mutation.targetId}"
        }
        return executed to result
    }

    // ── US-1208: create-before-edit ──

    @Test
    fun editDefers_whileItsCreateIsUnconfirmed_thenUnblocksSamePass() = runTest {
        // The create sits AFTER the edit in FIFO (an unusual but possible
        // interleave); the edit must defer, and once the create succeeds the
        // NEXT pass flushes the edit.
        queue.enqueue(MutationKind.UPDATE_INVENTORY_ITEM, "item1", ByteArray(0))
        queue.enqueue(MutationKind.CREATE_INVENTORY_ITEM, "item1", ByteArray(0))

        val (firstPass, firstResult) = executedKindsDrain()
        assertEquals(listOf("createInventoryItem:item1"), firstPass)
        assertEquals(1, firstResult.deferred)

        val (secondPass, _) = executedKindsDrain()
        assertEquals(listOf("updateInventoryItem:item1"), secondPass)
        assertEquals(0, db.pendingMutations().allInOrder().size)
    }

    @Test
    fun createFirstInFifo_unblocksItsEditInTheSamePass() = runTest {
        queue.enqueue(MutationKind.CREATE_INVENTORY_ITEM, "item1", ByteArray(0))
        queue.enqueue(MutationKind.UPDATE_INVENTORY_ITEM, "item1", ByteArray(0))

        val (executed, result) = executedKindsDrain()
        assertEquals(
            listOf("createInventoryItem:item1", "updateInventoryItem:item1"),
            executed,
        )
        assertEquals(0, result.deferred)
    }

    @Test
    fun aStuckCreate_stillBlocksItsDependents() = runTest {
        queue.enqueue(MutationKind.CREATE_INVENTORY_ITEM, "item1", ByteArray(0))
        queue.enqueue(MutationKind.UPDATE_INVENTORY_ITEM, "item1", ByteArray(0))
        // Pin the create stuck (past the budget).
        val createId = db.pendingMutations().allInOrder().first().id
        db.pendingMutations().markAttempt(createId, OfflineMutationQueue.MAX_RETRIES, "x", 1L)

        val (executed, result) = executedKindsDrain()
        assertEquals(emptyList<String>(), executed)
        assertEquals(1, result.deferred) // the edit waits for the stuck create
        assertEquals(1, result.skippedStuck)
    }

    // ── US-1496: blocked-target hold ──

    @Test
    fun aFailedTarget_holdsLaterSameTargetMutations() = runTest {
        queue.enqueue(MutationKind.UPDATE_INVENTORY_ITEM, "item1", ByteArray(0))
        queue.enqueue(MutationKind.UPDATE_INVENTORY_ITEM, "item1", ByteArray(0))
        queue.enqueue(MutationKind.UPDATE_INVENTORY_ITEM, "item2", ByteArray(0))

        val (executed, result) = executedKindsDrain(
            failing = mapOf("item1" to EdgeApiError.Network("blip")),
        )
        // item1's first update failed → its second HELD; item2 unaffected.
        assertEquals(listOf("updateInventoryItem:item2"), executed)
        assertEquals(1, result.transientFailures)
        assertEquals(1, result.deferred)
    }

    // ── Terminal vs transient ──

    @Test
    fun terminalFailure_marksStuckImmediately() = runTest {
        queue.enqueue(MutationKind.DELETE_PHOTO, "p1", ByteArray(0))
        val (_, result) = executedKindsDrain(
            failing = mapOf("p1" to EdgeApiError.NotFound("gone")),
        )
        assertEquals(1, result.markedStuck)
        val row = db.pendingMutations().allInOrder().single()
        assertEquals(OfflineMutationQueue.MAX_RETRIES, row.retryCount)
        assertEquals("gone", row.lastError)
    }

    @Test
    fun transientFailure_bumpsRetryAndStaysQueued() = runTest {
        queue.enqueue(MutationKind.CREATE_SALE, "s1", ByteArray(0))
        executedKindsDrain(failing = mapOf("s1" to EdgeApiError.Network("offline")))
        val row = db.pendingMutations().allInOrder().single()
        assertEquals(1, row.retryCount)
        assertEquals("offline", row.lastError)
        // Retryable again next pass.
        val (executed, _) = executedKindsDrain()
        assertEquals(listOf("createSale:s1"), executed)
    }

    @Test
    fun inspectorActions_retryNowAndDiscard() = runTest {
        queue.enqueue(MutationKind.CREATE_EXPENSE, "e1", ByteArray(0))
        val id = db.pendingMutations().allInOrder().single().id
        db.pendingMutations().markAttempt(id, OfflineMutationQueue.MAX_RETRIES, "stuck", 1L)

        queue.retryNow(id)
        assertEquals(0, db.pendingMutations().allInOrder().single().retryCount)
        assertNull(db.pendingMutations().allInOrder().single().lastError)

        queue.discard(id)
        assertEquals(0, queue.snapshot().size)
    }

    // ── Enqueue gating + classification (pure) ──

    @Test
    fun enqueueGate_onlyConnectivityShapedFailures() {
        assertTrue(OfflineMutationQueue.shouldEnqueue(EdgeApiError.Network("x")))
        assertTrue(OfflineMutationQueue.shouldEnqueue(EdgeApiError.ServerError(null)))
        assertTrue(OfflineMutationQueue.shouldEnqueue(IOException("reset")))
        // Validation / RLS / not-found surface to the user, never queue.
        assertFalse(OfflineMutationQueue.shouldEnqueue(EdgeApiError.BadRequest("invalid")))
        assertFalse(OfflineMutationQueue.shouldEnqueue(EdgeApiError.Unauthorized))
        assertFalse(OfflineMutationQueue.shouldEnqueue(IllegalStateException("bug")))
    }

    @Test
    fun terminalClassification_matrix() {
        assertTrue(OfflineMutationQueue.isTerminal(EdgeApiError.NotFound(null)))
        assertTrue(OfflineMutationQueue.isTerminal(EdgeApiError.BadRequest(null)))
        assertFalse(OfflineMutationQueue.isTerminal(EdgeApiError.Network("x")))
        assertFalse(OfflineMutationQueue.isTerminal(EdgeApiError.ServerError(null)))
        assertFalse(OfflineMutationQueue.isTerminal(EdgeApiError.Unauthorized))
        assertFalse(OfflineMutationQueue.isTerminal(EdgeApiError.RateLimited()))
    }

    @Test
    fun pendingEditProtection_coversCreatesAndUpdates() {
        val rows = listOf(
            PendingMutationEntity("1", "createInventoryItem", ByteArray(0), "a", 0, null, null, 1),
            PendingMutationEntity("2", "updateInventoryItem", ByteArray(0), "b", 0, null, null, 2),
            PendingMutationEntity("3", "createSale", ByteArray(0), "c", 0, null, null, 3),
        )
        assertEquals(setOf("a", "b"), OfflineMutationQueue.itemIdsWithPendingEdits(rows))
    }
}
