package com.gradethread.app.capture

import com.gradethread.app.intake.IntakeInbox
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-2461 AC2: a retired slot decodes forever and is never offered again.
 *
 * The two halves of that rule pull in opposite directions and both matter. A
 * row written last year says `detail_2`, so [PhotoSlotType.fromWire] has to keep
 * accepting it or the photo disappears from a gallery. But offering it as a NEW
 * choice mints a tag that tells the grader nothing about what the photo shows,
 * and migration 00587 rewrites it on arrival.
 *
 * The measurement half of this was narrowed by US-1576 and the tag/detail half
 * nine lines below it was missed, which left the capture Add menu, the
 * share-target dropdown AND the automatic share spill all handing out retired
 * slots for months. A list is easy to narrow and easy to un-narrow; this is the
 * thing that notices.
 */
class RetiredSlotsNeverOfferedTest {

    /** Exactly what migration 00587 retired. */
    private val retiredWire = setOf(
        "tag_2", "detail_2", "detail_3", "detail_4",
        "measurement_chest", "measurement_waist", "measurement_length",
        "measurement_sleeve", "measurement_inseam",
    )

    @Test
    fun `every retired type still decodes`() {
        // The half that must never change. A gallery that drops a photo because
        // its tag went out of fashion has lost the seller's work.
        for (wire in retiredWire) {
            assertNotNull("$wire must still round-trip", PhotoSlotType.fromWire(wire))
        }
        assertEquals(retiredWire, PhotoSlotType.retired.map { it.wire }.toSet())
    }

    @Test
    fun `no retired type is offered as a choice`() {
        // Every list the UI builds a picker or an auto-assignment from.
        val offered = PhotoSlotType.defaultSlots +
            PhotoSlotType.extras +
            PhotoSlotType.measurements +
            PhotoSlotType.defects +
            PhotoSlotType.required
        for (slot in offered) {
            assertFalse(
                "${slot.wire} is retired and must not be offered",
                slot.wire in retiredWire,
            )
        }
    }

    @Test
    fun `a shared batch is never auto-assigned a retired slot`() {
        // The worst of the three surfaces: no seller ever chose these. Sharing
        // six photos silently minted two rows the server then rewrote.
        val slots = IntakeInbox.defaultSlots(IntakeInbox.MAX_PHOTOS)
        assertTrue("the spill must actually fill slots", slots.size >= 5)
        for (slot in slots) {
            assertFalse("${slot.wire} is retired", slot.wire in retiredWire)
        }
    }

    @Test
    fun `the share spill does not call an ordinary photo a defect`() {
        // Dropping a fifth photo into "Defect 1" is not a filing decision, it is
        // a claim about the garment that the seller never made.
        val slots = IntakeInbox.defaultSlots(IntakeInbox.MAX_PHOTOS)
        val firstSpill = slots.drop(PhotoSlotType.defaultSlots.size).firstOrNull()
        assertNotNull(firstSpill)
        assertFalse(
            "the first spill slot must not be a defect",
            firstSpill in PhotoSlotType.defects,
        )
    }

    @Test
    fun `the four defaults are untouched`() {
        // Front, back, tag, detail shape or block a grade. Narrowing the extras
        // must not have moved them.
        assertEquals(
            listOf("front", "back", "tag", "detail"),
            PhotoSlotType.defaultSlots.map { it.wire },
        )
    }
}
