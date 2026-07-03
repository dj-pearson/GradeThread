package com.gradethread.app.platform.workspace

import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/**
 * US-1309: the tenant-scope source of truth — resolution fallback, real-change
 * gating on the switch signal, and the US-794 revocation recovery.
 */
class WorkspaceScopeTest {

    private class MemoryStore : WorkspaceScope.MutableStore {
        var value: String? = null
        override fun get(): String? = value
        override fun put(value: String?) {
            this.value = value
        }
    }

    private lateinit var store: MemoryStore

    @Before
    fun setUp() {
        store = MemoryStore()
        WorkspaceScope.initializeForTest(store)
        WorkspaceScope.clear()
    }

    @Test
    fun tenantOwnerId_fallsBackToSelf() {
        assertNull(WorkspaceScope.activeOwnerId)
        assertEquals("self-1", WorkspaceScope.tenantOwnerId("self-1"))

        WorkspaceScope.setActive("owner-9")
        assertEquals("owner-9", WorkspaceScope.tenantOwnerId("self-1"))
    }

    @Test
    fun setActive_normalizesEmptyToPersonal() {
        WorkspaceScope.setActive("owner-9")
        WorkspaceScope.setActive("")
        assertNull(WorkspaceScope.activeOwnerId)
    }

    @Test
    fun changeSignal_firesOnlyOnRealChanges() = runTest(UnconfinedTestDispatcher()) {
        val events = mutableListOf<WorkspaceScope.Event>()
        val job = launch { WorkspaceScope.events.toList(events) }

        WorkspaceScope.setActive("owner-9")
        WorkspaceScope.setActive("owner-9") // redundant — must not churn the cache
        WorkspaceScope.setActive(null)

        assertEquals(
            listOf<WorkspaceScope.Event>(
                WorkspaceScope.Event.Changed,
                WorkspaceScope.Event.Changed,
            ),
            events,
        )
        job.cancel()
    }

    @Test
    fun accessRevoked_dropsScopeAndEmitsBothSignals() = runTest(UnconfinedTestDispatcher()) {
        val events = mutableListOf<WorkspaceScope.Event>()
        val job = launch { WorkspaceScope.events.toList(events) }

        WorkspaceScope.setActive("owner-9")
        WorkspaceScope.handleAccessRevoked()

        assertNull(WorkspaceScope.activeOwnerId)
        assertEquals(
            listOf(
                WorkspaceScope.Event.Changed,       // the switch
                WorkspaceScope.Event.Changed,       // revocation resets like a switch
                WorkspaceScope.Event.AccessRevoked, // the one-time notice
            ),
            events,
        )

        // Idempotent: a second revocation without an active scope is a no-op.
        WorkspaceScope.handleAccessRevoked()
        assertEquals(3, events.size)
        job.cancel()
    }
}
