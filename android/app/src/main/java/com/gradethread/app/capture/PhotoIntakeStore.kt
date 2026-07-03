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
 * Rules carried from iOS:
 *  - the strip shows the 4 default slots + revealed extras; Front+Back block
 *    continue, Tag+Detail are shown but skippable;
 *  - a capture lands in the ACTIVE slot then AUTO-ADVANCES to the next empty
 *    visible slot (stays put when everything's filled);
 *  - defects reveal ONE AT A TIME (the Add menu offers a single Defect entry
 *    while any remain hidden); extras/measurements reveal on demand;
 *  - the FULL state (photos map + active + revealed slots) persists to Room
 *    so process death/backgrounding recovers the draft.
 */
class PhotoIntakeStore(initial: State = State()) {

    @Serializable
    data class State(
        /** slot.wire → captured photo file path. */
        val photos: Map<String, String> = emptyMap(),
        val activeSlot: String = PhotoSlotType.FRONT.wire,
        val extraSlots: List<String> = emptyList(),
    ) {
        fun photoFor(slot: PhotoSlotType): String? = photos[slot.wire]
        val active: PhotoSlotType
            get() = PhotoSlotType.fromWire(activeSlot) ?: PhotoSlotType.FRONT
        val revealed: List<PhotoSlotType>
            get() = extraSlots.mapNotNull(PhotoSlotType.Companion::fromWire)
    }

    private val stateFlow = MutableStateFlow(initial)
    val state: StateFlow<State> = stateFlow

    // ── Derived (mirrors iOS computed properties) ────────────────────────────

    val visibleSlots: List<PhotoSlotType>
        get() = PhotoSlotType.defaultSlots + stateFlow.value.revealed

    val nextEmptySlot: PhotoSlotType?
        get() = visibleSlots.firstOrNull { stateFlow.value.photoFor(it) == null }

    val allRequiredFilled: Boolean
        get() = PhotoSlotType.required.all { stateFlow.value.photoFor(it) != null }

    /** Drives the exit-confirmation prompt. */
    val hasUnsavedShots: Boolean
        get() = stateFlow.value.photos.isNotEmpty()

    val nextHiddenDefectSlot: PhotoSlotType?
        get() = PhotoSlotType.defects.firstOrNull { it !in stateFlow.value.revealed }

    val canAddDefectSlot: Boolean
        get() = nextHiddenDefectSlot != null

    /** Add-menu entries: the next hidden defect first (one at a time), then
     *  every unrevealed extra/measurement in canonical order. */
    val hiddenExtraSlots: List<PhotoSlotType>
        get() {
            val revealed = stateFlow.value.revealed
            val out = mutableListOf<PhotoSlotType>()
            nextHiddenDefectSlot?.let(out::add)
            out += (PhotoSlotType.extras + PhotoSlotType.measurements)
                .filter { it !in revealed }
            return out
        }

    // ── Mutations ────────────────────────────────────────────────────────────

    /** Store a capture in the active slot, then auto-advance to next empty. */
    fun recordCapture(path: String) {
        val current = stateFlow.value
        val withPhoto = current.copy(photos = current.photos + (current.activeSlot to path))
        stateFlow.value = withPhoto
        nextEmptySlot?.let { stateFlow.value = withPhoto.copy(activeSlot = it.wire) }
    }

    fun setPhoto(slot: PhotoSlotType, path: String) {
        val current = stateFlow.value
        stateFlow.value = current.copy(photos = current.photos + (slot.wire to path))
    }

    fun clearPhoto(slot: PhotoSlotType) {
        val current = stateFlow.value
        stateFlow.value = current.copy(photos = current.photos - slot.wire)
    }

    fun setActiveSlot(slot: PhotoSlotType) {
        stateFlow.value = stateFlow.value.copy(activeSlot = slot.wire)
    }

    /** Reveal an optional slot (defect/extra/measurement) and activate it. */
    fun reveal(slot: PhotoSlotType) {
        val current = stateFlow.value
        if (slot.wire in current.extraSlots) {
            stateFlow.value = current.copy(activeSlot = slot.wire)
            return
        }
        stateFlow.value = current.copy(
            extraSlots = current.extraSlots + slot.wire,
            activeSlot = slot.wire,
        )
    }

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
