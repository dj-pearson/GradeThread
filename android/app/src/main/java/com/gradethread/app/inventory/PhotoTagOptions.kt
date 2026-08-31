package com.gradethread.app.inventory

import com.gradethread.app.ui.UiMessage
import com.gradethread.app.capture.FlipdeskPhotoType
import com.gradethread.app.capture.GarmentGroup
import com.gradethread.app.capture.PhotoProfile
import com.gradethread.app.capture.PhotoRoleVocabulary

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
    data class Choice(val type: String, val role: String?, val label: UiMessage) {
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
    fun build(photoType: String, photoRole: String?, profile: PhotoProfile): Menu {
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
            // The profile's wording is the server's, so it goes through as
            // `detail`; the type's own resource sits behind it as the fallback.
            suggested += Choice(r.type, r.role, FlipdeskPhotoType.label(r.type, r.role, profile))
        }

        // US-2461: "All types" enumerates ROLES, not bare types.
        //
        // It used to map every type to `Choice(type, null, …)`, which meant a
        // role the item's profile did not happen to suggest was UNREACHABLE on
        // a phone rather than demoted — "Fabric close-up" and "Made in / union
        // label" simply did not exist unless the profile named them, and the
        // menu instead offered a bare "Detail" that web deliberately suppresses.
        // That is hiding, and the AC is that nothing is hidden.
        //
        // A type that takes a qualifier contributes one choice PER ROLE and
        // none for the bare type: picking "Detail" with no qualifier is not
        // something anyone wants with "Fabric close-up" sitting right there, and
        // an unqualified option would quietly compete with the qualified ones.
        val group = GarmentGroup.from(profile.category.substringAfterLast(':'))
        val allTypes = FlipdeskPhotoType.all
            .asSequence()
            .filterNot { FlipdeskPhotoType.isRetired(it) }
            .flatMap { type ->
                val roles = PhotoRoleVocabulary.rolesFor(type, group)
                when {
                    roles.isNotEmpty() ->
                        roles.asSequence().map { (key, res) -> Choice(type, key, UiMessage(res)) }
                    // `measurement` takes roles, but only the profile knows
                    // which — so it contributes whatever the profile suggested
                    // and never a bare, unqualified measurement (which is the
                    // MeasureCard calibration frame, not a tape close-up).
                    PhotoRoleVocabulary.takesRole(type) -> emptySequence()
                    else -> sequenceOf(Choice(type, null, FlipdeskPhotoType.label(type)))
                }
            }
            .filterNot { it.slot in seen }
            .toList()

        // US-2976: the alphabetical sort MOVED to the screen. It ordered by the
        // display text, and display text is now per-language - sorting the
        // English here would hand a Spanish seller a menu in English order.
        val offered = seen + allTypes.map { it.slot }
        val orphan = if (current in offered) {
            null
        } else {
            Choice(photoType, photoRole, FlipdeskPhotoType.label(photoType, photoRole, profile))
        }

        return Menu(suggested = suggested, allTypes = allTypes, orphan = orphan, current = current)
    }
}
