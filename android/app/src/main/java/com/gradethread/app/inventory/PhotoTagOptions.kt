package com.gradethread.app.inventory

import com.gradethread.app.capture.FlipdeskPhotoType
import com.gradethread.app.capture.PhotoProfile

/**
 * US-2469: the choices a retag menu offers, as data.
 *
 * Kept out of the Composable so the grouping rule is testable on the JVM — the
 * rule is the whole feature, and a Compose UI test would prove the menu renders
 * without proving it offers the right things.
 *
 * Two sections, matching web (`photo-tag-select.tsx`) and iOS
 * (`PhotoManagerView.changeTypeMenu`):
 *
 *   1. Suggested — this item's own profile, in CAPTURE order (Front → Back →
 *      Tag → Detail → measurements), because that is the order a seller shoots
 *      in, so the next tag they want is the next one down.
 *   2. All types — everything else, A-Z, so a rare tag is findable by name
 *      rather than by knowing where it sits in a canonical ordering.
 *
 * Nothing is hidden. Anything not suggested is demoted, never removed.
 */
object PhotoTagOptions {

    /** One choice. [slot] is the (type, role) identity, not the type. */
    data class Choice(
        val type: String,
        val role: String?,
        val label: String,
    ) {
        val slot: String get() = PhotoProfile.slotKey(type, role)
    }

    data class Menu(
        val suggested: List<Choice>,
        val allTypes: List<Choice>,
        /**
         * The photo's CURRENT choice when it is not offered by either section —
         * a row still sitting on a retired type. Shown, marked, so a seller can
         * see what it is and pick something current instead of facing a blank.
         */
        val orphan: Choice?,
        /** The current slot key, for the checkmark. */
        val current: String,
    )

    /**
     * Build the menu for one photo.
     *
     * [profile] supplies the suggested section AND its wording: the profile's
     * label is written for this category ("Sweatband" on a hat, not
     * "Interior / Lining"), so it wins over the catalog's generic name.
     */
    fun build(
        photoType: String,
        photoRole: String?,
        profile: PhotoProfile,
    ): Menu {
        val current = PhotoProfile.slotKey(photoType, photoRole)

        // The profile's own slots, deduped by slot key. A profile is server
        // data this client did not author, so a duplicate slot is possible and
        // must not produce two identical menu rows.
        val seen = LinkedHashSet<String>()
        val suggested = mutableListOf<Choice>()
        for (r in profile.roles) {
            // A profile that names a retired type cannot resurrect it.
            if (FlipdeskPhotoType.isRetired(r.type)) continue
            val key = PhotoProfile.slotKey(r.type, r.role)
            if (!seen.add(key)) continue
            suggested += Choice(r.type, r.role, r.label)
        }

        val allTypes = FlipdeskPhotoType.all
            .asSequence()
            .filterNot { FlipdeskPhotoType.isRetired(it) }
            .map { Choice(it, null, FlipdeskPhotoType.label(it)) }
            .filterNot { it.slot in seen }
            .sortedBy { it.label.lowercase() }
            .toList()

        val offered = seen + allTypes.map { it.slot }
        val orphan = if (current in offered) {
            null
        } else {
            Choice(photoType, photoRole, FlipdeskPhotoType.label(photoType, photoRole, profile))
        }

        return Menu(suggested = suggested, allTypes = allTypes, orphan = orphan, current = current)
    }
}
