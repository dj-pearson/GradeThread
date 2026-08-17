package com.gradethread.app.capture

import com.gradethread.app.sync.db.CaptureDraftEntity
import com.gradethread.app.sync.db.GradeThreadDb
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * US-1324: the capture-session state machine (iOS PhotoIntakeStore). Pure
 * over an immutable [State] snapshot so every rule unit-tests; the CameraX
 * screen observes [state].
 *
 * US-2498: a slot is a [CaptureSlot] - a (photo_type, photo_role) pair - and
 * WHICH slots exist comes from the resolved [PhotoProfile], not from a fixed
 * list of enum cases. A suit profile can therefore hold three separate tag
 * shots, and a pair of trousers is never offered a sleeve measurement.
 *
 * Rules carried from iOS:
 *  - the strip shows the profile's default slots + revealed extras; the
 *    profile's blocking slots (front+back) gate continue, the rest are
 *    skippable;
 *  - a capture lands in the ACTIVE slot then AUTO-ADVANCES to the next empty
 *    visible slot (stays put when everything's filled);
 *  - defects reveal ONE AT A TIME (the Add menu offers a single Defect entry
 *    while any remain hidden); every other optional slot reveals on demand;
 *  - the FULL state (photos map + active + revealed slots) persists to Room
 *    so process death/backgrounding recovers the draft.
 */
class PhotoIntakeStore(initial: State = State(), initialProfile: PhotoProfile = PhotoProfile.clothingFallback) {

    @Serializable
    data class State(
        /** [CaptureSlot.storageKey] → captured photo file path. */
        val photos: Map<String, String> = emptyMap(),
        val activeSlot: String = PhotoSlotType.FRONT.wire,
        val extraSlots: List<String> = emptyList(),
    ) {
        fun photoFor(slot: CaptureSlot): String? = photos[slot.storageKey]

        /**
         * The unroled photo for a bare type. A role-less slot's storage key IS
         * its wire value, so this is the same lookup - kept for the surfaces
         * that legitimately deal in types alone (the share-target inbox, which
         * assigns from a picker with no profile in hand).
         */
        fun photoFor(slot: PhotoSlotType): String? = photos[slot.wire]

        val activeCaptureSlot: CaptureSlot
            get() = CaptureSlot.fromStorageKey(activeSlot) ?: CaptureSlot(PhotoSlotType.FRONT)
        val active: PhotoSlotType
            get() = activeCaptureSlot.type
        val revealedSlots: List<CaptureSlot>
            get() = extraSlots.mapNotNull(CaptureSlot::fromStorageKey)
        val revealed: List<PhotoSlotType>
            get() = revealedSlots.map { it.type }
    }

    private val stateFlow = MutableStateFlow(initial)
    val state: StateFlow<State> = stateFlow

    private val profileFlow = MutableStateFlow(initialProfile)

    /**
     * The resolved profile for this item's category. Drives which slots the
     * strip offers; starts on the bundled fallback so the first frame renders
     * while [PhotoProfileStore] fetches the server table.
     */
    val profile: StateFlow<PhotoProfile> = profileFlow

    // ── Profile ──────────────────────────────────────────────────────────────

    /**
     * Swap in a resolved profile.
     *
     * Anything already CAPTURED under a slot the new profile does not show by
     * default is moved into the revealed extras rather than dropped: the photo
     * exists on disk and the seller took it on purpose, so the strip has to keep
     * a place for it even when the new profile has never heard of that slot.
     */
    fun apply(newProfile: PhotoProfile) {
        if (newProfile == profileFlow.value) return
        val current = stateFlow.value
        val base = newProfile.defaultCaptureSlots.toSet()
        val carried =
            (current.revealedSlots + current.photos.keys.mapNotNull(CaptureSlot::fromStorageKey))
                .distinct()
                .filter { it !in base }
                .map { it.storageKey }

        profileFlow.value = newProfile
        var next = current.copy(extraSlots = carried)
        if (visibleSlotsOf(next).none { it.storageKey == next.activeSlot }) {
            val fallback = visibleSlotsOf(next).firstOrNull { next.photoFor(it) == null }
                ?: visibleSlotsOf(next).firstOrNull()
                ?: CaptureSlot(PhotoSlotType.FRONT)
            next = next.copy(activeSlot = fallback.storageKey)
        }
        stateFlow.value = next
    }

    // ── Derived (mirrors iOS computed properties) ────────────────────────────

    private fun visibleSlotsOf(snapshot: State): List<CaptureSlot> =
        profileFlow.value.defaultCaptureSlots + snapshot.revealedSlots

    val visibleSlots: List<CaptureSlot>
        get() = visibleSlotsOf(stateFlow.value)

    val nextEmptySlot: CaptureSlot?
        get() = visibleSlots.firstOrNull { stateFlow.value.photoFor(it) == null }

    /**
     * The blocking slots for this profile - front + back in every profile
     * shipped so far, but READ from the profile rather than assumed.
     */
    val requiredSlots: List<CaptureSlot>
        get() = profileFlow.value.captureSlots.filter { it.isBlocking }
            .ifEmpty { CaptureSlot.blocking }

    val allRequiredFilled: Boolean
        get() = requiredSlots.all { stateFlow.value.photoFor(it) != null }

    /** Drives the exit-confirmation prompt. */
    val hasUnsavedShots: Boolean
        get() = stateFlow.value.photos.isNotEmpty()

    val nextHiddenDefectSlot: CaptureSlot?
        get() {
            val revealed = stateFlow.value.revealedSlots
            return profileFlow.value.defectCaptureSlots.firstOrNull { it !in revealed }
        }

    val canAddDefectSlot: Boolean
        get() = nextHiddenDefectSlot != null

    /**
     * Add-menu entries: the next hidden defect first (one at a time), then every
     * profile slot not already in the strip, in profile order.
     *
     * US-2498: this used to be `PhotoSlotType.extras + .measurements` - a fixed
     * list that offered a handbag the same three extras it offered a t-shirt.
     */
    val hiddenExtraSlots: List<CaptureSlot>
        get() {
            val out = mutableListOf<CaptureSlot>()
            nextHiddenDefectSlot?.let(out::add)
            val shown = visibleSlots.toSet()
            out += profileFlow.value.optionalCaptureSlots.filter { it !in shown }
            return out
        }

    // ── Mutations ────────────────────────────────────────────────────────────

    /**
     * Where the next [count] photos will land, without recording them.
     *
     * US-2639: the library-import path has to choose a RESOLUTION CAP before it
     * processes, and the cap is per-slot — but the slot is only decided by
     * [recordCapture]'s auto-advance, which runs after. So the destinations have
     * to be predicted.
     *
     * This mirrors [recordCapture] exactly: the first photo goes to the CURRENT
     * active slot (not the next empty one — that difference is the whole trap),
     * and each subsequent photo to the next slot still without a photo.
     * `PhotoIntakeStoreTest` records N photos through the real function and
     * asserts they land in exactly these slots, so the mirroring is pinned
     * rather than assumed — a prediction that drifts would silently compress a
     * serial shot at the default cap.
     */
    fun plannedDestinations(count: Int): List<CaptureSlot> {
        val snapshot = stateFlow.value
        val filled = snapshot.photos.keys.toMutableSet()
        val out = mutableListOf<CaptureSlot>()
        var next: CaptureSlot? = CaptureSlot.fromStorageKey(snapshot.activeSlot)
        repeat(count) {
            val slot = next ?: visibleSlotsOf(snapshot).firstOrNull { it.storageKey !in filled }
            if (slot == null) return out
            out += slot
            filled += slot.storageKey
            next = visibleSlotsOf(snapshot).firstOrNull { it.storageKey !in filled }
        }
        return out
    }

    /**
     * Store a capture in the active slot, then auto-advance to next empty.
     *
     * US-2658: [intoSlot] lets a caller PIN the destination before an async
     * hop. A camera shot is filed after a shutter round trip, and until this
     * existed the key was read from `activeSlot` at CALLBACK time — so tapping
     * a different chip while the shutter was in flight filed the photo under
     * the slot the seller had just moved to. The library-import path passes
     * nothing on purpose: a multi-pick fills successive slots by leaning on the
     * auto-advance below, which is the behaviour it wants.
     */
    fun recordCapture(path: String, intoSlot: String? = null) {
        val current = stateFlow.value
        val key = intoSlot ?: current.activeSlot
        val withPhoto = current.copy(photos = current.photos + (key to path))
        stateFlow.value = withPhoto
        nextEmptySlot?.let { stateFlow.value = withPhoto.copy(activeSlot = it.storageKey) }
    }

    fun setPhoto(slot: CaptureSlot, path: String) {
        val current = stateFlow.value
        stateFlow.value = current.copy(photos = current.photos + (slot.storageKey to path))
    }

    fun setPhoto(slot: PhotoSlotType, path: String) = setPhoto(CaptureSlot(slot), path)

    fun clearPhoto(slot: CaptureSlot) {
        val current = stateFlow.value
        stateFlow.value = current.copy(photos = current.photos - slot.storageKey)
    }

    fun setActiveSlot(slot: CaptureSlot) {
        stateFlow.value = stateFlow.value.copy(activeSlot = slot.storageKey)
    }

    fun setActiveSlot(slot: PhotoSlotType) = setActiveSlot(CaptureSlot(slot))

    /** Reveal an optional slot (defect or profile extra) and activate it. */
    fun reveal(slot: CaptureSlot) {
        val current = stateFlow.value
        if (slot.storageKey in current.extraSlots) {
            stateFlow.value = current.copy(activeSlot = slot.storageKey)
            return
        }
        stateFlow.value = current.copy(
            extraSlots = current.extraSlots + slot.storageKey,
            activeSlot = slot.storageKey,
        )
    }

    fun reveal(slot: PhotoSlotType) = reveal(CaptureSlot(slot))

    // ── Draft persistence (AC3) ──────────────────────────────────────────────

    companion object {
        private val json = Json { ignoreUnknownKeys = true }
        const val DRAFT_ID = "active" // one in-flight capture session

        suspend fun restore(db: GradeThreadDb): PhotoIntakeStore {
            val draft = db.captureDrafts().byId(DRAFT_ID) ?: return PhotoIntakeStore()
            val state = runCatching { json.decodeFromString(State.serializer(), draft.stateJson) }
                .getOrDefault(State())
            return PhotoIntakeStore(state)
        }
    }

    suspend fun persist(db: GradeThreadDb, clock: () -> Long = System::currentTimeMillis) {
        db.captureDrafts().upsert(
            CaptureDraftEntity(
                id = DRAFT_ID,
                stateJson = json.encodeToString(State.serializer(), stateFlow.value),
                updatedAt = clock(),
            ),
        )
    }

    /** The intake completed (or was explicitly discarded) — drop the draft. */
    suspend fun discardDraft(db: GradeThreadDb) {
        db.captureDrafts().delete(DRAFT_ID)
    }
}
