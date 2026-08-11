package com.gradethread.app.capture

import com.gradethread.app.inventory.MeasurementCatalog

/**
 * US-2469: the server-side `item_photos.photo_type` vocabulary — the Kotlin
 * mirror of the web's `FLIPDESK_PHOTO_TYPES` + `PHOTO_TYPE_LABELS`
 * (src/lib/constants.ts) and of the iOS `FlipdeskPhotoType`.
 *
 * [PhotoSlotType] covers CAPTURE-TIME slots; this covers rows that already
 * exist, which carry the server string. Android had neither a label lookup for
 * an arbitrary server type nor any notion of a retired type, which is why the
 * canvas rendered `measurement_chest` at a seller.
 */
object FlipdeskPhotoType {

    /**
     * All server photo types in the web's canonical display order:
     * Front → Back → Tag → Detail → measurements → defect → extras → universal.
     */
    val all: List<String> = listOf(
        "front", "back", "tag", "detail",
        // US-1571 (migration 00346): MeasureCard calibration frame — the whole
        // garment flat with the fiducial card beside it. Keys the
        // photo-measurement pipeline; the edge excludes it from eBay,
        // generation AI, and public surfaces (like "internal").
        "measurement",
        // US-1577 (migration 00350): generated card-free annotated measurements
        // photo. Listing-eligible, never primary.
        "measurement_overlay",
        "measurement_chest", "measurement_waist", "measurement_length",
        "measurement_sleeve", "measurement_inseam",
        "defect",
        "tag_2", "detail_2", "detail_3", "detail_4",
        "interior", "flatlay",
        // US-2468 (migration 00587): the two types the role epic added that had
        // no existing type to reuse.
        "on_hanger", "on_model", "set_pair",
        "angle", "sole", "marking", "serial", "accessory",
        "certificate", "corner", "surface",
        // US-1549: seller-reference only (price tag paid, receipt). Stays with
        // the item in-app; the edge excludes it from eBay, AI, and public
        // surfaces. Last on purpose.
        "internal",
    )

    /**
     * Photo types that must never ride a listing — the client mirror of the
     * edge's NON_LISTABLE_PHOTO_TYPES (lib/item-photo-storage.ts). The edge
     * enforces at publish; this keeps Android's listing surfaces honest too.
     */
    val nonListable: Set<String> = setOf("internal", "measurement")

    /**
     * US-2468: retired types. Still legal values forever — Postgres cannot drop
     * an enum value and historical rows point at them — but never offered as a
     * NEW choice. Migration 00587 rewrote existing rows onto the (type, role)
     * pairs below; the map stays so a row that has not been rewritten yet can
     * still be labelled, and so the migration and the client cannot disagree
     * about what `measurement_chest` meant.
     */
    val retired: Map<String, Pair<String, String?>> = mapOf(
        "tag_2" to ("tag" to null),
        "detail_2" to ("detail" to null),
        "detail_3" to ("detail" to null),
        "detail_4" to ("detail" to null),
        "measurement_chest" to ("measurement" to "chest"),
        "measurement_waist" to ("measurement" to "waist"),
        "measurement_length" to ("measurement" to "length"),
        "measurement_sleeve" to ("measurement" to "sleeve"),
        "measurement_inseam" to ("measurement" to "inseam"),
    )

    fun isRetired(serverType: String): Boolean = retired.containsKey(serverType)

    /**
     * True when a server `photo_type` never publishes to a marketplace.
     *
     * US-2468: role-aware, mirroring the edge's `isNonListableItemPhoto`.
     * `measurement` now covers two different photos and only one is unlistable:
     * a NULL role is the MeasureCard calibration frame (a branded foreign
     * object, never lists), while any role is a tape close-up — what
     * `measurement_chest` used to be, and something sellers publish on purpose.
     * Pre-00587 rows have a null role, so the old behavior is preserved exactly.
     */
    fun isNonListable(serverType: String, role: String? = null): Boolean {
        if (serverType == "measurement") return role.isNullOrEmpty()
        return serverType in nonListable
    }

    /**
     * Human label for a server `photo_type` string. Unknown values fall back to
     * a de-underscored capitalization so a new server type never renders as raw
     * snake_case — which is the specific bug this file exists to end.
     */
    fun label(serverType: String): String = when (serverType) {
        "front" -> "Front"
        "back" -> "Back"
        "tag" -> "Garment Tag"
        "tag_2" -> "Garment Tag 2"
        "detail" -> "Detail 1"
        "detail_2" -> "Detail 2"
        "detail_3" -> "Detail 3"
        "detail_4" -> "Detail 4"
        "interior" -> "Interior / Lining"
        "defect" -> "Defect"
        "flatlay" -> "Flat lay"
        "on_model" -> "On model"
        "on_hanger" -> "On hanger"
        "set_pair" -> "Set / pair"
        "angle" -> "Angle / Profile"
        "sole" -> "Sole"
        "marking" -> "Markings / Hallmark"
        "serial" -> "Serial / Model"
        "accessory" -> "Accessories / Box"
        "certificate" -> "Certificate / Label"
        "corner" -> "Corners"
        "surface" -> "Surface / Centering"
        "measurement" -> "Measurement card (not listed)"
        "measurement_overlay" -> "Measurements photo (generated)"
        "measurement_chest" -> "Measure: Chest / Bust"
        "measurement_waist" -> "Measure: Waist"
        "measurement_length" -> "Measure: Length"
        "measurement_sleeve" -> "Measure: Sleeve"
        "measurement_inseam" -> "Measure: Inseam"
        "internal" -> "Internal (not listed)"
        else -> serverType.split("_").joinToString(" ") { part ->
            part.replaceFirstChar { it.uppercase() }
        }
    }

    /**
     * US-2468: the label for a stored (type, role) PAIR.
     *
     * The role is what carries the meaning now, so a bare type label is the
     * FALLBACK rather than the answer: a `detail` with role 'fabric' is a
     * "Fabric close-up", not "Detail 1". `profile` supplies the
     * category-specific wording when one is loaded — the same reason the web
     * picker prefers the profile's label ("Sweatband" on a hat, not
     * "Interior / Lining").
     */
    fun label(serverType: String, role: String?, profile: PhotoProfile? = null): String {
        val match = profile?.roleFor(serverType, role)
        if (match != null && match.role == role) return match.label
        if (!role.isNullOrEmpty()) {
            return PhotoRoleVocabulary.label(serverType, role) ?: label(serverType)
        }
        return label(serverType)
    }
}

/**
 * US-2469: the role half of the tag vocabulary — the Kotlin mirror of
 * src/lib/photo-roles.ts, matching iOS `PhotoRoleVocabulary`.
 *
 * Only the LABELS live here. The authoritative per-garment role LISTS come from
 * the profile table the edge serves, so a new role ships without a Play Store
 * release; this table exists so a role that arrives before the app knows about
 * it still renders as words rather than as `made_in`.
 */
object PhotoRoleVocabulary {

    val tagRoles: List<Pair<String, String>> = listOf(
        "brand" to "Brand label",
        "size" to "Size tag",
        "care" to "Care & fabric",
        "made_in" to "Made in / union label",
        "size_alt" to "Trouser size tag",
    )

    val detailRoles: List<Pair<String, String>> = listOf(
        "fabric" to "Fabric close-up",
        "hem" to "Hem & stitching",
        "hardware" to "Hardware",
        "pocket" to "Pocket",
        "print" to "Print or graphic",
        "collar" to "Collar or cuff",
        "handles" to "Handles & straps",
        "base" to "Base",
        "ends_edges" to "Ends & edges",
        "insole" to "Insole",
    )

    /**
     * Measurement roles are DERIVED from the measurement templates on the
     * server, so their keys are measurement field keys. Labelled from the shared
     * catalog rather than a second hand-maintained list.
     */
    fun label(type: String, role: String): String? = when (type) {
        "tag" -> tagRoles.firstOrNull { it.first == role }?.second
        "detail" -> detailRoles.firstOrNull { it.first == role }?.second
        // MeasurementCatalog already de-underscores unknown keys, so a role the
        // app has never seen still reads as words.
        "measurement" -> "Measure: ${MeasurementCatalog.label(role)}"
        else -> null
    }
}
