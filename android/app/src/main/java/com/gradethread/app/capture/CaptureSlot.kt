package com.gradethread.app.capture

import com.gradethread.app.ui.UiMessage

/**
 * One position in the capture strip, identified by the (photo_type, photo_role)
 * PAIR — US-2498, the Android half of the iOS US-2470 change.
 *
 * WHY THIS EXISTS AND [PhotoSlotType] STILL DOES. The strip was a list of
 * [PhotoSlotType] cases, which forced a new enum case for every extra photo a
 * category wanted: `tag_2`, `detail_2`, `detail_3`, `detail_4`,
 * `measurement_chest` and friends. That vocabulary could not grow without a Play
 * Store release, and it could not say what the extra photo actually WAS - a suit
 * needs three tag shots (brand, size, trouser size) and `tag_2` names none of
 * them.
 *
 * Migration 00587 split the answer into `item_photos.photo_type` (the physical
 * kind) and `item_photos.photo_role` (what it shows). A CaptureSlot is that
 * pair, plus the label and hint the resolved [PhotoProfile] supplies - so a
 * hat's interior slot reads "Sweatband" and a jacket's reads "Lining" without
 * either word being compiled in.
 *
 * [PhotoSlotType] keeps its job: the capture-time vocabulary that owns the
 * storage bucket, the server photo_type and the offline-draft key. This wraps
 * it rather than replacing it.
 *
 * IDENTITY IS THE PAIR, NOTHING ELSE. [equals] and [hashCode] read only
 * [storageKey], so a slot rebuilt from a draft or from a profile that arrived
 * mid-session still matches the one already in the strip. If the label took part
 * in equality, a profile arriving from the network would silently orphan every
 * photo already captured under the bundled fallback's wording.
 */
class CaptureSlot(
    /** The physical capture kind - bucket, sensitivity, server photo_type. */
    val type: PhotoSlotType,
    role: String? = null,
    label: String? = null,
    hint: String? = null,
    isBlocking: Boolean? = null,
) {
    /**
     * The `item_photos.photo_role` qualifier, or null for a slot that takes
     * none. Null and blank are the same thing and both normalize to null.
     */
    val role: String? = role?.trim()?.takeIf { it.isNotEmpty() }

    /**
     * What this slot is called.
     *
     * US-2976: a UiMessage, because there are TWO possible sources and only
     * one of them is ours. A category profile can name the slot, and that
     * wording arrives from the server, so it goes in `detail` and is shown
     * exactly as it came. With no profile label, [PhotoSlotType.label] is our
     * own copy and translates.
     *
     * The precedence is unchanged - the profile still wins - so this is only
     * the untranslated half becoming translatable. Whether a Spanish seller
     * SHOULD read an English profile label is a separate question, and one
     * this shape makes a one-line change to answer either way.
     */
    val label: UiMessage = UiMessage(type.label, detail = label)

    /** One-line capture guidance, from the profile or our own default. */
    val hint: UiMessage = UiMessage(type.hint, detail = hint)

    /** Must be filled before the item can advance - front + back, in practice. */
    val isBlocking: Boolean = isBlocking ?: (type in PhotoSlotType.required)

    /**
     * Stable, round-trippable identity: `"front"`, or `"tag|size"`.
     *
     * The separator is `|` rather than the `:` that [PhotoProfile.slotKey] uses,
     * because this key is also a FILENAME component in the draft directory. It
     * keys on [PhotoSlotType.wire], not on [PhotoSlotType.serverPhotoType], so
     * the three defect slots stay distinct - they all write `photo_type =
     * "defect"`.
     */
    val storageKey: String
        get() = role?.let { "${type.wire}|$it" } ?: type.wire

    /** The `item_photos.photo_type` this slot writes. */
    val serverPhotoType: String get() = type.serverPhotoType

    /** A garment tag close-up, whatever role it carries. */
    val isTagSlot: Boolean get() = type.isTagSlot

    /** True for the defect slots, which reveal one at a time. */
    val isDefect: Boolean get() = type in PhotoSlotType.defects

    override fun equals(other: Any?): Boolean = other is CaptureSlot && other.storageKey == storageKey

    override fun hashCode(): Int = storageKey.hashCode()

    override fun toString(): String = storageKey

    companion object {
        /**
         * Rebuilds a slot from a [storageKey], or null when this build has no
         * case for the type - a draft written by a newer build is skipped
         * rather than crashing.
         *
         * A bare `"front"` (no separator) is the pre-US-2498 draft shape and
         * still decodes: drafts on disk at upgrade time must not be discarded.
         */
        fun fromStorageKey(key: String): CaptureSlot? {
            val i = key.indexOf('|')
            val wire = if (i == -1) key else key.substring(0, i)
            val role = if (i == -1) null else key.substring(i + 1)
            val type = PhotoSlotType.fromWire(wire) ?: return null
            return CaptureSlot(type = type, role = role)
        }

        /**
         * The strip before any profile resolves: front, back, tag, detail.
         *
         * Kept as a real fallback rather than an empty list because
         * [PhotoProfileStore] starts on a bundled table and only later swaps in
         * the server's - a strip that rendered nothing for the first frame
         * would be a visible flash on every launch.
         */
        val defaults: List<CaptureSlot> = PhotoSlotType.defaultSlots.map { CaptureSlot(it) }

        /** The blocking set: front + back, and deliberately not tag or detail. */
        val blocking: List<CaptureSlot> = PhotoSlotType.required.map { CaptureSlot(it) }

        /**
         * How many slots the strip shows before the seller opens "Add more".
         * Four, because that is what it has always shown; the number is a
         * thumb-reach decision, not a taxonomy one.
         */
        const val DEFAULT_STRIP_SIZE = 4

        /** The three defect slots in reveal order, carrying a profile's wording. */
        fun defectSlots(label: String, hint: String): List<CaptureSlot> = PhotoSlotType.defects.map {
            CaptureSlot(type = it, role = null, label = label, hint = hint, isBlocking = false)
        }
    }
}

// ── Profile → slots ─────────────────────────────────────────────────────────

/**
 * This profile role as a capture slot, or null when the app has no capture case
 * for the type.
 *
 * RETIRED TYPES ARE REFUSED HERE (US-2498). `tag_2`, `detail_2..4` and
 * `measurement_*` stay legal values forever - Postgres cannot drop an enum value
 * and historical rows point at them - but a NEW capture must never write one.
 * Refusing at the single point where a profile becomes a slot means no capture
 * surface has to remember the rule.
 */
fun PhotoRole.captureSlot(): CaptureSlot? {
    if (FlipdeskPhotoType.isRetired(type)) return null
    val slotType = PhotoSlotType.fromWire(type) ?: return null
    return CaptureSlot(
        type = slotType,
        role = role,
        label = label,
        hint = hint,
        isBlocking = required && slotType in PhotoSlotType.required,
    )
}

/**
 * Every non-defect role as a capture slot, in PROFILE ORDER.
 *
 * That order is the contract: it is the gallery order on the web and index 0 is
 * the eBay cover image, so [CapturePublishPlan] derives `sort_order` from a
 * photo's position in this list. Defects are excluded because they reveal one at
 * a time through their own mechanism.
 *
 * DEDUPED, first occurrence wins. The profile table is server data this client
 * did not author, and a duplicated role would put two identical keys in a
 * LazyRow - which is a crash, not an extra row.
 */
val PhotoProfile.captureSlots: List<CaptureSlot>
    get() {
        val seen = mutableSetOf<String>()
        return roles
            .filter { it.type != "defect" }
            .mapNotNull { it.captureSlot() }
            .filter { seen.add(it.storageKey) }
    }

/**
 * US-2498 AC2: the server photo types this build has no capture case for.
 *
 * Dropping them silently is what the story is about - a seller photographing a
 * suit on an older build would simply never be offered the slot the category
 * asks for, with nothing on screen saying so. The capture screen renders this as
 * a one-line notice; [captureSlots] still omits them, because offering a slot
 * whose type the uploader cannot name would fail later and worse.
 */
val PhotoProfile.unsupportedRoleTypes: List<String>
    get() = roles
        // `defect` is deliberately absent from [PhotoSlotType] — the enum holds
        // defect1..3, which all WRITE `defect`, because the strip reveals them
        // one at a time. It is handled, not missing.
        .filter { it.type != "defect" }
        .filter { !FlipdeskPhotoType.isRetired(it.type) && PhotoSlotType.fromWire(it.type) == null }
        .map { it.type }
        .distinct()

/**
 * Slots shown in the strip from the start: every blocking role, then one slot of
 * each further KIND until the strip is full.
 *
 * Not simply "the required ones" - the server profiles mark only front and back
 * required, and a strip that opened on two slots would hide the tag and detail
 * shots sellers are meant to reach for without thinking. Not simply "the first
 * four" either: clothing's role order is front, back, tag:brand, tag:size, so
 * that would offer two tag slots and no detail.
 *
 * One of each kind up front, the variants behind "Add more". For clothing that
 * resolves to front, back, tag, detail - the strip this has always shown - and
 * for a watch it resolves to that category's own four, without either list being
 * written down twice.
 */
val PhotoProfile.defaultCaptureSlots: List<CaptureSlot>
    get() {
        val all = captureSlots
        if (all.isEmpty()) return CaptureSlot.defaults
        val out = mutableListOf<CaptureSlot>()
        val seenTypes = mutableSetOf<String>()
        all.filter { it.isBlocking }.forEach {
            out += it
            seenTypes += it.serverPhotoType
        }
        for (slot in all) {
            if (out.size >= CaptureSlot.DEFAULT_STRIP_SIZE) break
            if (!seenTypes.add(slot.serverPhotoType)) continue
            out += slot
        }
        return out.ifEmpty { CaptureSlot.defaults }
    }

/** Slots offered behind "Add more": everything else, in profile order. */
val PhotoProfile.optionalCaptureSlots: List<CaptureSlot>
    get() {
        val shown = defaultCaptureSlots.toSet()
        return captureSlots.filter { it !in shown }
    }

/** The defect slots this profile allows, already carrying its wording. */
val PhotoProfile.defectCaptureSlots: List<CaptureSlot>
    get() {
        val defect = roles.firstOrNull { it.type == "defect" } ?: return emptyList()
        return CaptureSlot.defectSlots(label = defect.label, hint = defect.hint)
    }
