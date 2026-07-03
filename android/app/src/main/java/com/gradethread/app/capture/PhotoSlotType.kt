package com.gradethread.app.capture

/**
 * US-1324: the canonical photo positions (iOS PhotoSlotType). Wire values
 * equal the server `photo_type` strings so they round-trip through drafts
 * and offline sync without translation; only defect1–3 collapse to the
 * shared server type `defect`. DECLARATION ORDER IS THE CANONICAL
 * GALLERY/COVER ORDER — sort_order derives from ordinal, so FRONT is the
 * cover / eBay main image.
 */
enum class PhotoSlotType(val wire: String, val label: String) {
    FRONT("front", "Front"),
    BACK("back", "Back"),
    TAG("tag", "Tag"),
    DETAIL("detail", "Detail"),
    MEASUREMENT_CHEST("measurement_chest", "Chest / Bust"),
    MEASUREMENT_WAIST("measurement_waist", "Waist"),
    MEASUREMENT_LENGTH("measurement_length", "Length"),
    MEASUREMENT_SLEEVE("measurement_sleeve", "Sleeve"),
    MEASUREMENT_INSEAM("measurement_inseam", "Inseam"),
    DEFECT1("defect1", "Defect 1"),
    DEFECT2("defect2", "Defect 2"),
    DEFECT3("defect3", "Defect 3"),
    TAG2("tag_2", "Tag 2"),
    DETAIL2("detail_2", "Detail 2"),
    DETAIL3("detail_3", "Detail 3"),
    DETAIL4("detail_4", "Detail 4"),
    INTERIOR("interior", "Interior"),
    FLATLAY("flatlay", "Flat lay"),
    ON_MODEL("on_model", "On model"),
    // Universal roles (migration 00230) for non-clothing photo profiles.
    ANGLE("angle", "Angle / Profile"),
    SOLE("sole", "Sole"),
    MARKING("marking", "Markings"),
    SERIAL("serial", "Serial / Model"),
    ACCESSORY("accessory", "Accessories"),
    CERTIFICATE("certificate", "Certificate"),
    CORNER("corner", "Corners"),
    SURFACE("surface", "Surface"),
    ;

    /** Server item_photos.photo_type — defects collapse to `defect`. */
    val serverPhotoType: String
        get() = if (this in defects) "defect" else wire

    /** Single-line cue above the strip while this slot is active. */
    val hint: String
        get() = when (this) {
            FRONT -> "Lay flat, full front in frame"
            BACK -> "Same crop as the front shot"
            TAG -> "Care + size label, close enough to read"
            DETAIL -> "Texture, weave, or distinctive feature"
            DEFECT1, DEFECT2, DEFECT3 -> "Close-up of the flaw, well lit"
            else -> "Optional shot — add what buyers ask about"
        }

    companion object {
        /** The strip's default four (Front+Back block continue; Tag+Detail skippable). */
        val defaultSlots = listOf(FRONT, BACK, TAG, DETAIL)

        /** Blocking-required (00306: front+back only). */
        val required = listOf(FRONT, BACK)

        /** Revealed ONE AT A TIME via the Add menu. */
        val defects = listOf(DEFECT1, DEFECT2, DEFECT3)

        val measurements = listOf(
            MEASUREMENT_CHEST, MEASUREMENT_WAIST, MEASUREMENT_LENGTH,
            MEASUREMENT_SLEEVE, MEASUREMENT_INSEAM,
        )

        /** Non-defect, non-measurement optionals in display order. */
        val extras = listOf(TAG2, DETAIL2, DETAIL3, DETAIL4, INTERIOR, FLATLAY, ON_MODEL)

        fun fromWire(value: String): PhotoSlotType? =
            entries.firstOrNull { it.wire == value }
    }
}
