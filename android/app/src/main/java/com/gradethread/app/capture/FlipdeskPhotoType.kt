package com.gradethread.app.capture

import androidx.annotation.StringRes
import com.gradethread.app.R
import com.gradethread.app.inventory.MeasurementCatalog
import com.gradethread.app.ui.UiMessage

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
    @StringRes
    private fun labelRes(serverType: String): Int? = when (serverType) {
        "front" -> R.string.photo_type_front
        "back" -> R.string.photo_type_back
        "tag" -> R.string.photo_type_tag
        "tag_2" -> R.string.photo_type_tag_2
        "detail" -> R.string.photo_type_detail
        "detail_2" -> R.string.photo_type_detail_2
        "detail_3" -> R.string.photo_type_detail_3
        "detail_4" -> R.string.photo_type_detail_4
        "interior" -> R.string.photo_type_interior
        "defect" -> R.string.photo_type_defect
        "flatlay" -> R.string.photo_type_flatlay
        "on_model" -> R.string.photo_type_on_model
        "on_hanger" -> R.string.photo_type_on_hanger
        "set_pair" -> R.string.photo_type_set_pair
        "angle" -> R.string.photo_type_angle
        "sole" -> R.string.photo_type_sole
        "marking" -> R.string.photo_type_marking
        "serial" -> R.string.photo_type_serial
        "accessory" -> R.string.photo_type_accessory
        "certificate" -> R.string.photo_type_certificate
        "corner" -> R.string.photo_type_corner
        "surface" -> R.string.photo_type_surface
        "measurement" -> R.string.photo_type_measurement
        "measurement_overlay" -> R.string.photo_type_measurement_overlay
        "measurement_chest" -> R.string.photo_type_measurement_chest
        "measurement_waist" -> R.string.photo_type_measurement_waist
        "measurement_length" -> R.string.photo_type_measurement_length
        "measurement_sleeve" -> R.string.photo_type_measurement_sleeve
        "measurement_inseam" -> R.string.photo_type_measurement_inseam
        "internal" -> R.string.photo_type_internal
        else -> null
    }

    /**
     * What a stored server photo type is called on screen.
     *
     * US-2976: a type this build has never seen still renders as words rather
     * than as `made_in`, and that derived name arrives as `detail` - it came
     * off the wire and is not ours to translate.
     */
    fun label(serverType: String): UiMessage {
        val res = labelRes(serverType)
            ?: return UiMessage(
                R.string.photo_type_unknown,
                detail = serverType.split("_").joinToString(" ") { part ->
                    part.replaceFirstChar { it.uppercase() }
                },
            )
        return UiMessage(res)
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
    fun label(serverType: String, role: String?, profile: PhotoProfile? = null): UiMessage {
        val match = profile?.roleFor(serverType, role)
        // The profile's wording comes from the server, so it is `detail` and is
        // shown exactly as it arrived; the type's own resource sits behind it.
        if (match != null && match.role == role) {
            return UiMessage(labelRes(serverType) ?: R.string.photo_type_unknown, match.label)
        }
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

    val tagRoles: List<Pair<String, Int>> = listOf(
        "brand" to R.string.photo_role_tag_brand,
        "size" to R.string.photo_role_tag_size,
        "care" to R.string.photo_role_tag_care,
        "made_in" to R.string.photo_role_tag_made_in,
        "size_alt" to R.string.photo_role_tag_size_alt,
    )

    val detailRoles: List<Pair<String, Int>> = listOf(
        "fabric" to R.string.photo_role_detail_fabric,
        "hem" to R.string.photo_role_detail_hem,
        "hardware" to R.string.photo_role_detail_hardware,
        "pocket" to R.string.photo_role_detail_pocket,
        "print" to R.string.photo_role_detail_print,
        "collar" to R.string.photo_role_detail_collar,
        "handles" to R.string.photo_role_detail_handles,
        "base" to R.string.photo_role_detail_base,
        "ends_edges" to R.string.photo_role_detail_ends_edges,
        "insole" to R.string.photo_role_detail_insole,
    )

    /**
     * Measurement roles are DERIVED from the measurement templates on the
     * server, so their keys are measurement field keys. Labelled from the shared
     * catalog rather than a second hand-maintained list.
     */
    fun label(type: String, role: String): UiMessage? = when (type) {
        "tag" -> tagRoles.firstOrNull { it.first == role }?.second?.let { UiMessage(it) }
        "detail" -> detailRoles.firstOrNull { it.first == role }?.second?.let { UiMessage(it) }
        // MeasurementCatalog already de-underscores unknown keys, so a role the
        // app has never seen still reads as words.
        //
        // US-2976: `display`, not `label`. The wire label is what gets drawn
        // into the buyer-facing overlay; this is what the SELLER reads, and it
        // nests inside "Measure: %1$s" as a message in its own right.
        "measurement" -> UiMessage(
            R.string.photo_role_measure,
            args = listOf(MeasurementCatalog.display(role)),
        )

        else -> null
    }

    // US-2461: which of the roles above belong to which garment group. The base
    // lists above are the flat union of every group, which is the right shape
    // for LABELLING an arbitrary stored role but the wrong shape for OFFERING
    // one — "Handles & straps" in a t-shirt's menu is exactly the noise the
    // epic set out to remove. Mirrors DETAIL_ROLES_BY_GROUP / TAG_ROLES_BY_GROUP
    // in src/lib/photo-roles.ts.
    private val baseTagRoleKeys = listOf("brand", "size", "care", "made_in")
    private val baseDetailRoleKeys =
        listOf("fabric", "hem", "hardware", "pocket", "print", "collar")
    private val detailRoleKeysByGroup: Map<GarmentGroup, List<String>> = mapOf(
        GarmentGroup.BAG to listOf("handles", "base"),
        GarmentGroup.ACCESSORY to listOf("ends_edges"),
        GarmentGroup.SHOES to listOf("insole"),
    )
    private val tagRoleKeysByGroup: Map<GarmentGroup, List<String>> = mapOf(
        // Only a suit needs a second size label: it is the only garment that is
        // genuinely two garments, and a buyer needs both numbers.
        GarmentGroup.SUIT to listOf("size_alt"),
    )

    /**
     * US-2461: every role a seller may PICK for [type] on a [group] garment,
     * as (key, label) pairs in offer order.
     *
     * `measurement` deliberately returns nothing. Its roles are the group's
     * measurement-template fields, which only the server knows — they arrive on
     * the photo profile, so the profile is the one authority for them and
     * duplicating the template table on a third client would just create a way
     * for the two to disagree.
     */
    fun rolesFor(type: String, group: GarmentGroup): List<Pair<String, Int>> = when (type) {
        "tag" -> (baseTagRoleKeys + (tagRoleKeysByGroup[group] ?: emptyList()))
            .mapNotNull { key -> tagRoles.firstOrNull { it.first == key } }
        "detail" -> (baseDetailRoleKeys + (detailRoleKeysByGroup[group] ?: emptyList()))
            .mapNotNull { key -> detailRoles.firstOrNull { it.first == key } }
        else -> emptyList()
    }

    /** True when [type] carries a qualifier at all — mirrors `typeTakesRole`. */
    fun takesRole(type: String): Boolean = type == "tag" || type == "detail" || type == "measurement"
}
