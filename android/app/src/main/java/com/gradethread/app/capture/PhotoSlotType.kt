package com.gradethread.app.capture

import androidx.annotation.StringRes
import com.gradethread.app.R

/**
 * US-1324: the canonical photo positions (iOS PhotoSlotType). Wire values
 * equal the server `photo_type` strings so they round-trip through drafts
 * and offline sync without translation; only defect1–3 collapse to the
 * shared server type `defect`. DECLARATION ORDER IS THE CANONICAL
 * GALLERY/COVER ORDER — sort_order derives from ordinal, so FRONT is the
 * cover / eBay main image.
 */
// US-2976: the WIRE value stays a String - the server compares it, and the
// header above says so - and the label beside it is a resource id. Keeping
// them in one constructor is the point: they are the same fact.
enum class PhotoSlotType(val wire: String, @StringRes val label: Int) {
    FRONT("front", R.string.slot_label_front),
    BACK("back", R.string.slot_label_back),
    TAG("tag", R.string.slot_label_tag),
    DETAIL("detail", R.string.slot_label_detail),
    MEASUREMENT_CHEST("measurement_chest", R.string.slot_label_measurement_chest),
    MEASUREMENT_WAIST("measurement_waist", R.string.slot_label_measurement_waist),
    MEASUREMENT_LENGTH("measurement_length", R.string.slot_label_measurement_length),
    MEASUREMENT_SLEEVE("measurement_sleeve", R.string.slot_label_measurement_sleeve),
    MEASUREMENT_INSEAM("measurement_inseam", R.string.slot_label_measurement_inseam),
    DEFECT1("defect1", R.string.slot_label_defect1),
    DEFECT2("defect2", R.string.slot_label_defect2),
    DEFECT3("defect3", R.string.slot_label_defect3),
    TAG2("tag_2", R.string.slot_label_tag2),
    DETAIL2("detail_2", R.string.slot_label_detail2),
    DETAIL3("detail_3", R.string.slot_label_detail3),
    DETAIL4("detail_4", R.string.slot_label_detail4),
    INTERIOR("interior", R.string.slot_label_interior),
    FLATLAY("flatlay", R.string.slot_label_flatlay),
    ON_MODEL("on_model", R.string.slot_label_on_model),

    // Universal roles (migration 00230) for non-clothing photo profiles.
    ANGLE("angle", R.string.slot_label_angle),
    SOLE("sole", R.string.slot_label_sole),
    MARKING("marking", R.string.slot_label_marking),
    SERIAL("serial", R.string.slot_label_serial),
    ACCESSORY("accessory", R.string.slot_label_accessory),
    CERTIFICATE("certificate", R.string.slot_label_certificate),
    CORNER("corner", R.string.slot_label_corner),
    SURFACE("surface", R.string.slot_label_surface),

    /**
     * US-1576: the MeasureCard frame — the garment flat with the printed card
     * beside it, which the server calibrates into a px→inch ruler.
     *
     * APPENDED rather than filed beside the retired `measurement_*` slots, for
     * two independent reasons. Declaration order is the gallery order, and this
     * photo is NON-LISTABLE ([FlipdeskPhotoType.nonListable]) — a shot that
     * never reaches a buyer must never outrank one that does. And [ordinal] is
     * the per-slot offset that keeps storage paths unique
     * ([CapturePublishPlan.build]), so appending leaves every existing slot's
     * path arithmetic exactly where it was.
     */
    MEASUREMENT("measurement", R.string.slot_label_measurement),

    /**
     * US-2498 (migration 00587): the two profile roles that had no capture case
     * at all, so a profile offering them dropped the slot without saying so.
     * iOS added the same two in US-2470.
     *
     * APPENDED for the reason [MEASUREMENT] is: [ordinal] is a stable per-slot
     * key and the pre-profile ordering has to stay exactly where it was.
     */
    ON_HANGER("on_hanger", R.string.slot_label_on_hanger),
    SET_PAIR("set_pair", R.string.slot_label_set_pair),
    ;

    /** Server item_photos.photo_type — defects collapse to `defect`. */
    val serverPhotoType: String
        get() = if (this in defects) "defect" else wire

    /**
     * A garment TAG close-up, whatever role it carries. The AI extract's OCR
     * pass waits on one of these, and once a profile can name three of them
     * (`tag:brand`, `tag:size`, `tag:care`) an `== TAG` check matches none.
     */
    val isTagSlot: Boolean
        get() = this == TAG || this == TAG2

    /** Single-line cue above the strip while this slot is active. */
    @get:StringRes
    val hint: Int
        get() = when (this) {
            FRONT -> R.string.slot_hint_front
            BACK -> R.string.slot_hint_back
            TAG -> R.string.slot_hint_tag
            DETAIL -> R.string.slot_hint_detail
            DEFECT1, DEFECT2, DEFECT3 -> R.string.slot_hint_defect
            // Mirrors the iOS MeasureCard hint word for word: every failure the
            // server's quality gate can report is one of these four things.
            MEASUREMENT -> R.string.slot_hint_measurement
            ON_HANGER -> R.string.slot_hint_on_hanger
            SET_PAIR -> R.string.slot_hint_set_pair
            else -> R.string.slot_hint_optional
        }

    companion object {
        /** The strip's default four (Front+Back block continue; Tag+Detail skippable). */
        val defaultSlots = listOf(FRONT, BACK, TAG, DETAIL)

        /** Blocking-required (00306: front+back only). */
        val required = listOf(FRONT, BACK)

        /** Revealed ONE AT A TIME via the Add menu. */
        val defects = listOf(DEFECT1, DEFECT2, DEFECT3)

        /**
         * The measurement slot a seller can still choose: one MeasureCard shot.
         *
         * US-1576: this used to be the five `measurement_*` slots, every one of
         * which migration 00587 RETIRED — so the Add menu was offering five
         * choices the server rewrites the moment they land, and offering none
         * of the one slot the calibrate/extract endpoints actually accept
         * (`photo_type = "measurement"`). Retired types stay legal forever and
         * keep round-tripping through [fromWire]; they are simply never offered
         * again, which is the rule US-2469 set for the retag menu.
         */
        val measurements = listOf(MEASUREMENT)

        /** Kept for [fromWire] round-tripping only — never offered as a choice. */
        val retiredMeasurements = listOf(
            MEASUREMENT_CHEST,
            MEASUREMENT_WAIST,
            MEASUREMENT_LENGTH,
            MEASUREMENT_SLEEVE,
            MEASUREMENT_INSEAM,
        )

        /**
         * Non-defect, non-measurement optionals in display order.
         *
         * US-2461: the four numbered slots came out for the same reason the
         * five `measurement_*` ones did nine lines above, and were missed when
         * that half was narrowed. A photo tagged "Detail 3" told the grader
         * nothing about what it showed, and migration 00587 retired it — so the
         * Add menu was offering four choices the server rewrites the moment
         * they land. The replacement is a (type, role) pair chosen in the retag
         * menu, which enumerates real roles ("Hem & stitching", "Made in").
         */
        val extras = listOf(INTERIOR, FLATLAY, ON_MODEL)

        /** Kept for [fromWire] round-tripping only — never offered as a choice. */
        val retiredExtras = listOf(TAG2, DETAIL2, DETAIL3, DETAIL4)

        /** Every type migration 00587 retired: legal to decode, never to offer. */
        val retired = retiredMeasurements + retiredExtras

        fun fromWire(value: String): PhotoSlotType? = entries.firstOrNull { it.wire == value }
    }
}
