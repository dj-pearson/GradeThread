package com.gradethread.app.capture

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.gradethread.app.sync.db.GradeThreadDb
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * US-1324: the intake state machine — slot vocabulary, auto-advance,
 * one-at-a-time defect reveal, and draft recovery through real Room.
 */
@RunWith(RobolectricTestRunner::class)
class PhotoIntakeStoreTest {

    // ── Slot vocabulary ──

    @Test
    fun slotVocabulary_matchesTheIosContract() {
        assertEquals(
            listOf(PhotoSlotType.FRONT, PhotoSlotType.BACK, PhotoSlotType.TAG, PhotoSlotType.DETAIL),
            PhotoSlotType.defaultSlots,
        )
        // 00306: required is front+back ONLY.
        assertEquals(listOf(PhotoSlotType.FRONT, PhotoSlotType.BACK), PhotoSlotType.required)
        // Defects collapse to the shared server type; others are their wire value.
        assertEquals("defect", PhotoSlotType.DEFECT2.serverPhotoType)
        assertEquals("tag_2", PhotoSlotType.TAG2.serverPhotoType)
        // Declaration order IS the sort order — FRONT is the cover.
        assertEquals(0, PhotoSlotType.FRONT.ordinal)
    }

    // ── Auto-advance ──

    @Test
    fun capture_landsInActiveSlot_thenAdvancesToNextEmpty() {
        val store = PhotoIntakeStore()
        assertEquals(PhotoSlotType.FRONT, store.state.value.active)

        store.recordCapture("/p/front.jpg")
        assertEquals("/p/front.jpg", store.state.value.photoFor(PhotoSlotType.FRONT))
        assertEquals(PhotoSlotType.BACK, store.state.value.active)

        store.recordCapture("/p/back.jpg")
        assertEquals(PhotoSlotType.TAG, store.state.value.active)
        assertTrue(store.allRequiredFilled) // front+back only (00306)
    }

    @Test
    fun captureWithAllVisibleFilled_staysPut() {
        val store = PhotoIntakeStore()
        PhotoSlotType.defaultSlots.forEach { store.setPhoto(it, "/p/${it.wire}.jpg") }
        store.setActiveSlot(PhotoSlotType.DETAIL)
        store.recordCapture("/p/detail2.jpg") // overwrite; nowhere to advance
        assertEquals(PhotoSlotType.DETAIL, store.state.value.active)
        assertNull(store.nextEmptySlot)
    }

    @Test
    fun manualSlotSwitch_overridesAutoFlow() {
        val store = PhotoIntakeStore()
        store.setActiveSlot(PhotoSlotType.TAG)
        store.recordCapture("/p/tag.jpg")
        // Auto-advance scans from the strip start: FRONT is still empty.
        assertEquals(PhotoSlotType.FRONT, store.state.value.active)
    }

    // ── Defect reveal (one at a time) ──

    @Test
    fun defects_revealOneAtATime() {
        val store = PhotoIntakeStore()
        assertEquals(PhotoSlotType.DEFECT1, store.nextHiddenDefectSlot)
        // The Add menu offers exactly ONE defect entry while any remain hidden.
        assertEquals(1, store.hiddenExtraSlots.count { it in PhotoSlotType.defects })

        store.reveal(PhotoSlotType.DEFECT1)
        assertEquals(PhotoSlotType.DEFECT1, store.state.value.active) // reveal activates
        assertEquals(PhotoSlotType.DEFECT2, store.nextHiddenDefectSlot)
        assertTrue(PhotoSlotType.DEFECT1 in store.visibleSlots)

        store.reveal(PhotoSlotType.DEFECT2)
        store.reveal(PhotoSlotType.DEFECT3)
        assertNull(store.nextHiddenDefectSlot)
        assertFalse(store.canAddDefectSlot)
    }

    @Test
    fun revealingAnAlreadyVisibleSlot_justActivatesIt() {
        val store = PhotoIntakeStore()
        store.reveal(PhotoSlotType.FLATLAY)
        store.setActiveSlot(PhotoSlotType.FRONT)
        store.reveal(PhotoSlotType.FLATLAY) // second reveal
        assertEquals(PhotoSlotType.FLATLAY, store.state.value.active)
        // Not duplicated in the strip.
        assertEquals(1, store.visibleSlots.count { it == PhotoSlotType.FLATLAY })
    }

    @Test
    fun hiddenExtras_orderIsDefectThenExtrasThenMeasurements() {
        val store = PhotoIntakeStore()
        val menu = store.hiddenExtraSlots
        assertEquals(PhotoSlotType.DEFECT1, menu.first())
        val tagIdx = menu.indexOf(PhotoSlotType.TAG2)
        val chestIdx = menu.indexOf(PhotoSlotType.MEASUREMENT_CHEST)
        assertTrue(tagIdx in 1 until chestIdx)
    }

    // ── Draft recovery (AC3) ──

    @Test
    fun draft_persistsAndRecoversTheFullState() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val db = Room.inMemoryDatabaseBuilder(context, GradeThreadDb::class.java)
            .allowMainThreadQueries()
            .build()

        val store = PhotoIntakeStore()
        store.recordCapture("/p/front.jpg")
        store.reveal(PhotoSlotType.DEFECT1)
        store.setPhoto(PhotoSlotType.DEFECT1, "/p/defect.jpg")
        store.setActiveSlot(PhotoSlotType.TAG)
        store.persist(db)

        // "Process death": a brand-new store restored from Room.
        val recovered = PhotoIntakeStore.restore(db)
        assertEquals("/p/front.jpg", recovered.state.value.photoFor(PhotoSlotType.FRONT))
        assertEquals("/p/defect.jpg", recovered.state.value.photoFor(PhotoSlotType.DEFECT1))
        assertEquals(PhotoSlotType.TAG, recovered.state.value.active)
        assertTrue(PhotoSlotType.DEFECT1 in recovered.visibleSlots)

        recovered.discardDraft(db)
        assertFalse(PhotoIntakeStore.restore(db).hasUnsavedShots)
        db.close()
    }
}
