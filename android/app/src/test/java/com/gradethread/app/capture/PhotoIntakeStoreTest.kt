package com.gradethread.app.capture

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.gradethread.app.sync.db.GradeThreadDb
import kotlinx.coroutines.test.runTest
import com.gradethread.app.R
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
 *
 * US-2498: the strip is now the resolved [PhotoProfile]'s slots, so these read
 * the store's own [PhotoIntakeStore.visibleSlots] rather than assuming
 * front/back/tag/detail. That is the point of the change: the assumption was
 * only ever right for clothing.
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
        // FRONT is still the cover, and its ordinal is still the stable key the
        // storage path leans on.
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
        val strip = store.visibleSlots
        strip.forEach { store.setPhoto(it, "/p/${it.storageKey}.jpg") }
        store.setActiveSlot(strip.last())
        store.recordCapture("/p/again.jpg") // overwrite; nowhere to advance
        assertEquals(strip.last(), store.state.value.activeCaptureSlot)
        assertNull(store.nextEmptySlot)
    }

    @Test
    fun manualSlotSwitch_overridesAutoFlow() {
        val store = PhotoIntakeStore()
        store.setActiveSlot(store.visibleSlots[2])
        store.recordCapture("/p/tag.jpg")
        // Auto-advance scans from the strip start: FRONT is still empty.
        assertEquals(PhotoSlotType.FRONT, store.state.value.active)
    }

    // ── Defect reveal (one at a time) ──

    @Test
    fun defects_revealOneAtATime() {
        val store = PhotoIntakeStore()
        val defects = PhotoProfile.clothingFallback.defectCaptureSlots
        assertEquals(defects.first(), store.nextHiddenDefectSlot)
        // The Add menu offers exactly ONE defect entry while any remain hidden.
        assertEquals(1, store.hiddenExtraSlots.count { it.isDefect })

        store.reveal(defects[0])
        assertEquals(defects[0], store.state.value.activeCaptureSlot) // reveal activates
        assertEquals(defects[1], store.nextHiddenDefectSlot)
        assertTrue(defects[0] in store.visibleSlots)

        store.reveal(defects[1])
        store.reveal(defects[2])
        assertNull(store.nextHiddenDefectSlot)
        assertFalse(store.canAddDefectSlot)
    }

    @Test
    fun revealingAnAlreadyVisibleSlot_justActivatesIt() {
        val store = PhotoIntakeStore()
        val flatlay = CaptureSlot(PhotoSlotType.FLATLAY)
        store.reveal(flatlay)
        store.setActiveSlot(PhotoSlotType.FRONT)
        store.reveal(flatlay) // second reveal
        assertEquals(flatlay, store.state.value.activeCaptureSlot)
        // Not duplicated in the strip.
        assertEquals(1, store.visibleSlots.count { it == flatlay })
    }

    @Test
    fun hiddenExtras_offerTheDefectFirstThenTheProfilesOwnSlots() {
        val store = PhotoIntakeStore()
        val menu = store.hiddenExtraSlots
        assertTrue("a defect leads the menu", menu.first().isDefect)
        // Everything after the defect comes from the profile, in profile order,
        // and none of it is already in the strip.
        val optional = PhotoProfile.clothingFallback.optionalCaptureSlots
        assertEquals(optional, menu.drop(1))
        assertTrue(store.visibleSlots.none { it in menu })
    }

    @Test
    fun hiddenExtras_offersTheMeasureCardSlotAndNoRetiredMeasurementSlot() {
        // US-1576: the menu used to offer the five `measurement_*` slots, every
        // one of which migration 00587 retired — so the seller was choosing
        // between five tags the server rewrites on arrival, and could not
        // choose the ONE type calibrate/extract accept.
        val menu = PhotoIntakeStore().hiddenExtraSlots
        assertTrue(menu.any { it.type == PhotoSlotType.MEASUREMENT })
        PhotoSlotType.retiredMeasurements.forEach { retired ->
            assertTrue("$retired is retired and must never be offered", menu.none { it.type == retired })
        }
    }

    // ── US-2498: the profile drives the strip ──

    @Test
    fun theStripComesFromTheProfile_notFromTheEnum() {
        val watch = PhotoProfile(
            category = "watches",
            label = "Watches",
            roles = listOf(
                PhotoRole("front", "Dial", "Dial straight on", required = true, icon = "watch"),
                PhotoRole("back", "Caseback", "Caseback flat", required = true, icon = "watch"),
                PhotoRole("serial", "Serial", "Serial or model number", required = false, icon = "hash"),
                PhotoRole("accessory", "Box & papers", "Everything that comes with it", required = false, icon = "box"),
                PhotoRole("defect", "Damage", "Tight crop on any flaw", required = false, icon = "alert"),
            ),
        )
        val store = PhotoIntakeStore()
        store.apply(watch)

        assertEquals(
            listOf("front", "back", "serial", "accessory"),
            store.visibleSlots.map { it.storageKey },
        )
        // The profile's wording, not the enum's. US-2976: it arrives from the
        // server, so it is `detail` - the field shown exactly as it came - and
        // the enum's own resource sits behind it as the fallback.
        assertEquals("Dial", store.visibleSlots.first().label.detail)
        assertEquals(R.string.slot_label_front, store.visibleSlots.first().label.res)
        // A clothing-only slot is not on offer anywhere.
        assertTrue(store.hiddenExtraSlots.none { it.type == PhotoSlotType.FLATLAY })
    }

    @Test
    fun aSuitProfileCanHoldThreeSeparateTagShots() {
        // The reason CaptureSlot exists: three `tag` slots that are three
        // different photos, which a list of enum cases could not express.
        val store = PhotoIntakeStore()
        val tags = store.hiddenExtraSlots.plus(store.visibleSlots).filter { it.type == PhotoSlotType.TAG }
        assertTrue("expected several roled tag slots, got $tags", tags.size >= 3)
        assertEquals(tags.size, tags.map { it.storageKey }.distinct().size)
        assertTrue(tags.all { it.role != null })
    }

    @Test
    fun applyingAProfileKeepsPhotosAlreadyTaken() {
        val store = PhotoIntakeStore()
        store.reveal(CaptureSlot(PhotoSlotType.FLATLAY))
        store.setPhoto(CaptureSlot(PhotoSlotType.FLATLAY), "/p/flatlay.jpg")

        store.apply(PhotoProfile.genericFallback) // no flatlay role at all
        val flatlay = CaptureSlot(PhotoSlotType.FLATLAY)
        assertTrue("the shot the seller took must keep its place", flatlay in store.visibleSlots)
        assertEquals("/p/flatlay.jpg", store.state.value.photoFor(flatlay))
    }

    @Test
    fun applyingAProfileMovesTheActiveSlotWhenItDisappears() {
        val store = PhotoIntakeStore()
        store.setActiveSlot(store.visibleSlots[3]) // detail:fabric on clothing
        store.apply(PhotoProfile.genericFallback)
        assertTrue(store.state.value.activeCaptureSlot in store.visibleSlots)
    }

    // ── Draft recovery (AC3) ──

    @Test
    fun draft_persistsAndRecoversTheFullState() = runTest {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val db = Room.inMemoryDatabaseBuilder(context, GradeThreadDb::class.java)
            .allowMainThreadQueries()
            .build()

        val store = PhotoIntakeStore()
        val defect = PhotoProfile.clothingFallback.defectCaptureSlots.first()
        store.recordCapture("/p/front.jpg")
        store.reveal(defect)
        store.setPhoto(defect, "/p/defect.jpg")
        store.setActiveSlot(store.visibleSlots[2]) // a ROLED slot: tag:brand
        val activeKey = store.state.value.activeSlot
        store.persist(db)

        // "Process death": a brand-new store restored from Room.
        val recovered = PhotoIntakeStore.restore(db)
        assertEquals("/p/front.jpg", recovered.state.value.photoFor(PhotoSlotType.FRONT))
        assertEquals("/p/defect.jpg", recovered.state.value.photoFor(defect))
        // The (type, role) pair survives the round trip, not just the type.
        assertEquals(activeKey, recovered.state.value.activeSlot)
        assertEquals("brand", recovered.state.value.activeCaptureSlot.role)
        assertTrue(defect in recovered.visibleSlots)

        recovered.discardDraft(db)
        assertFalse(PhotoIntakeStore.restore(db).hasUnsavedShots)
        db.close()
    }

    @Test
    fun aPreUs2498DraftStillDecodes() {
        // Drafts written by the shipped build key on the bare wire value. They
        // are on disk at upgrade time and must not be thrown away.
        val store = PhotoIntakeStore(
            PhotoIntakeStore.State(
                photos = mapOf("front" to "/p/front.jpg"),
                activeSlot = "back",
                extraSlots = listOf("flatlay"),
            ),
        )
        assertEquals("/p/front.jpg", store.state.value.photoFor(CaptureSlot(PhotoSlotType.FRONT)))
        assertEquals(PhotoSlotType.BACK, store.state.value.active)
        assertTrue(CaptureSlot(PhotoSlotType.FLATLAY) in store.visibleSlots)
    }
    // ── US-2639: predicting where imported photos will land ──

    /**
     * [PhotoIntakeStore.plannedDestinations] must agree with [recordCapture].
     *
     * The import path picks a RESOLUTION CAP before it processes, and the cap
     * is per-slot - but the slot is only decided by the auto-advance, which
     * runs after. So the destinations are predicted, and a prediction that
     * drifts from the real rule would silently compress a serial shot at the
     * default cap: no crash, no wrong dimension, just half the pixels on the
     * photo whose whole job is fine detail.
     *
     * Recording is the oracle. This does not restate the rule, it runs it.
     */
    @Test
    fun plannedDestinations_matchWhereRecordingActuallyLands() {
        val store = PhotoIntakeStore()
        val predicted = store.plannedDestinations(4)

        val landed = mutableListOf<CaptureSlot>()
        repeat(4) { i ->
            val before = store.state.value.activeSlot
            store.recordCapture("/p/$i.jpg")
            landed += CaptureSlot.fromStorageKey(before)!!
        }
        assertEquals(predicted, landed)
    }

    @Test
    fun plannedDestinations_respectsAManualSlotSwitchAndTheRescanAfterIt() {
        // The case that makes this non-obvious: auto-advance scans from the
        // START of the strip, so after a manual jump to slot[2] the next photo
        // goes back to FRONT rather than onward to slot[3]. A prediction that
        // assumed forward order would be wrong from the second photo on.
        val store = PhotoIntakeStore()
        store.setActiveSlot(store.visibleSlots[2])
        val predicted = store.plannedDestinations(3)

        val landed = mutableListOf<CaptureSlot>()
        repeat(3) { i ->
            val before = store.state.value.activeSlot
            store.recordCapture("/p/m$i.jpg")
            landed += CaptureSlot.fromStorageKey(before)!!
        }
        assertEquals(predicted, landed)
        assertEquals(store.visibleSlots[2], predicted[0])
        assertEquals(CaptureSlot(PhotoSlotType.FRONT), predicted[1])
    }

    @Test
    fun plannedDestinations_stopsWhenTheStripIsFull() {
        val store = PhotoIntakeStore()
        store.visibleSlots.forEach { store.setPhoto(it, "/p/${it.storageKey}.jpg") }
        // Nowhere left to advance to: the active slot is the only answer, and
        // asking for more must not invent slots that do not exist.
        assertTrue(store.plannedDestinations(5).size <= 1)
    }
}
