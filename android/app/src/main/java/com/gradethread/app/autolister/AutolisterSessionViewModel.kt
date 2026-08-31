package com.gradethread.app.autolister

import android.content.Context
import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.capture.PhotoImport
import com.gradethread.app.capture.PhotoProcessor
import com.gradethread.app.sync.db.AutolisterSessionEntity
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import java.io.File
import java.util.UUID
import javax.inject.Inject

/**
 * US-2408: the AutoLister session that replaces the placeholder.
 *
 * Every state change is written to Room before the next one starts. A batch is
 * twenty minutes of a seller's photography and sorting, and Android will kill a
 * backgrounded process without warning — losing that to a phone call would be
 * worse than any latency the write costs.
 */
@HiltViewModel
class AutolisterSessionViewModel @Inject constructor(
    @ApplicationContext private val context: Context,
    private val service: AutolisterService,
    private val db: GradeThreadDb,
) : ViewModel() {

    /** What the session is doing, so one banner can say which. */
    enum class Busy { IMPORTING, PROPOSING, VERIFYING, SENDING }

    data class State(
        val loading: Boolean = true,
        val session: AutolisterSessionState = AutolisterSessionState(),
        val busy: Busy? = null,
        /** Import and upload progress, as done-of-total. */
        val done: Int = 0,
        val total: Int = 0,
        /** Photos that failed to upload; the batch continues without them. */
        val skipped: Int = 0,
        val errorMessage: UiMessage? = null,
        /** Batches already waiting on the shelf for a desktop to pick up. */
        val waiting: List<HandoffSummary> = emptyList(),
        val sentPhotoCount: Int? = null,
    ) {
        val photos: List<SessionPhoto> get() = session.photos
        val groups: List<SessionGroup> get() = session.groups
        val ungrouped: List<SessionPhoto> get() = session.ungrouped

        val canPropose: Boolean
            get() = busy == null && session.ungrouped.size >= AutolisterGroups.PROPOSE_MIN

        val canVerify: Boolean get() = busy == null && AutolisterGroups.canVerify(session)

        val canSend: Boolean get() = busy == null && session.photos.isNotEmpty()

        /** How many billed AI actions a propose pass would cost. */
        val proposeWindows: Int
            get() = AutolisterGroups.proposeWindows(session.ungrouped).size

        val remainingCapacity: Int
            get() = (AutolisterGroups.MAX_PHOTOS - session.photos.size).coerceAtLeast(0)
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            val row = db.autolisterSessions().byId(SESSION_ID)
            val restored = row?.let {
                runCatching { json.decodeFromString(AutolisterSessionState.serializer(), it.stateJson) }
                    .getOrNull()
            }
            _state.value = _state.value.copy(
                loading = false,
                // A session whose handoff already landed is finished; keeping
                // it would offer a "Send" that would upload the same batch to a
                // second shelf.
                session = restored?.takeIf { it.handoffId == null } ?: newSession(),
            )
            if (restored?.handoffId != null) persist()
            refreshWaiting()
        }
    }

    /** Batches on the shelf, so the phone can discard one it no longer wants. */
    fun refreshWaiting() {
        viewModelScope.launch {
            runCatching { service.handoffs() }
                .onSuccess { _state.value = _state.value.copy(waiting = it) }
        }
    }

    /**
     * Import picked photos and stage them.
     *
     * Per-photo isolation, deliberately: one unreadable file out of a hundred
     * must not end the import. Failures are counted and reported rather than
     * thrown, because the seller's remedy is to re-add those few, not to start
     * the batch again.
     */
    fun importPhotos(uris: List<Uri>) {
        if (_state.value.busy != null || uris.isEmpty()) return
        val session = _state.value.session
        val wanted = uris.take(_state.value.remainingCapacity)
        if (wanted.isEmpty()) return

        _state.value = _state.value.copy(
            busy = Busy.IMPORTING,
            done = 0,
            total = wanted.size,
            skipped = 0,
            errorMessage = null,
        )
        viewModelScope.launch {
            val staged = mutableListOf<SessionPhoto>()
            var skipped = 0
            val outputDir = File(context.cacheDir, "autolister").apply { mkdirs() }

            for (result in PhotoImport.importPicked(
                context,
                wanted,
                outputDir,
                limit = AutolisterGroups.MAX_PHOTOS,
            )) {
                val imported = result.getOrNull()
                if (imported == null) {
                    skipped += 1
                } else {
                    val photo = runCatching { stage(session.stagingSessionId, imported) }.getOrNull()
                    if (photo == null) skipped += 1 else staged += photo
                }
                _state.value = _state.value.copy(done = _state.value.done + 1, skipped = skipped)
            }

            update { AutolisterGroups.withPhotos(it, staged) }
            _state.value = _state.value.copy(
                busy = null,
                errorMessage = if (skipped > 0 && staged.isEmpty()) UPLOAD_FAILED else null,
            )
        }
    }

    private suspend fun stage(stagingSessionId: String, imported: PhotoImport.Imported): SessionPhoto {
        val file = imported.processed.file
        val upload = service.stagePhoto(
            stagingSessionId = stagingSessionId,
            fileName = file.name,
            bytes = file.readBytes(),
            // US-2895: the "autolister" subdirectory, NOT the cache root.
            //
            // This passed `context.cacheDir`, so 160px thumbnails of a seller's
            // garments were written loose into the top of the cache
            // (`<cache>/<name>_<mtime>_thumb.jpg`) rather than inside any named
            // directory. Sign-out clears StagedMedia's directories and would
            // have stepped straight over them, leaving one seller's garment
            // thumbnails for whoever signs in next. Same directory the import
            // above already stages into.
            thumbnail = runCatching {
                PhotoProcessor.thumbnailFor(file, File(context.cacheDir, "autolister"))
            }
                .getOrNull()?.readBytes(),
        )
        return SessionPhoto(
            id = UUID.randomUUID().toString(),
            storagePath = upload.storagePath,
            url = upload.url,
            thumbnailStoragePath = upload.thumbnailStoragePath,
            thumbnailUrl = upload.thumbnailUrl,
            width = upload.width,
            height = upload.height,
            bytes = upload.bytes,
            // Absent rather than zero when the file had no EXIF time — the
            // server reads this as shooting order, and 1970 would fold every
            // timeless photo into one burst.
            capturedAtMs = imported.exifCapturedAtMs,
            sourceName = file.name,
        )
    }

    /** Ask the model to group the ungrouped photos. One AI action per window. */
    fun proposeGroups() {
        if (!_state.value.canPropose) return
        val windows = AutolisterGroups.proposeWindows(_state.value.session.ungrouped)
        _state.value = _state.value.copy(
            busy = Busy.PROPOSING,
            done = 0,
            total = windows.size,
            errorMessage = null,
        )
        viewModelScope.launch {
            var failure: UiMessage? = null
            for (window in windows) {
                val refs = window.map { GroupPhotoRef(it.id, it.storagePath) }
                val response = runCatching { service.proposeGroups(refs) }
                    .onFailure { failure = service.message(it) }
                    .getOrNull()
                if (response != null) {
                    update { current ->
                        AutolisterGroups.applyProposals(
                            current,
                            response.groups,
                            List(response.groups.size) { UUID.randomUUID().toString() },
                        )
                    }
                }
                _state.value = _state.value.copy(done = _state.value.done + 1)
                // A refused window is usually quota or a plan wall, and the
                // next window would be refused identically — stop rather than
                // spend the seller's remaining actions proving it.
                if (response == null) break
            }
            _state.value = _state.value.copy(busy = null, errorMessage = failure)
        }
    }

    /** Ask the model to check the grouping. Returns suggestions, applies none. */
    fun verifyGroups() {
        if (!_state.value.canVerify) return
        _state.value = _state.value.copy(busy = Busy.VERIFYING, errorMessage = null)
        viewModelScope.launch {
            runCatching { service.verifyGroups(AutolisterGroups.verifyGroups(_state.value.session)) }
                .onSuccess { response -> update { it.copy(suggestions = response.suggestions) } }
                .onFailure {
                    _state.value = _state.value.copy(errorMessage = service.message(it))
                }
            _state.value = _state.value.copy(busy = null)
        }
    }

    fun applySuggestion(suggestion: GroupSuggestion) = update { current ->
        AutolisterGroups.withoutSuggestion(
            AutolisterGroups.applySuggestion(current, suggestion, UUID.randomUUID().toString()),
            suggestion,
        )
    }

    fun dismissSuggestion(suggestion: GroupSuggestion) = update { AutolisterGroups.withoutSuggestion(it, suggestion) }

    // ── the manual edits ─────────────────────────────────────────────────

    fun groupSelected(photoIds: List<String>) =
        update { AutolisterGroups.grouped(it, photoIds, UUID.randomUUID().toString()) }

    fun splitFromGroup(groupId: String, photoIds: List<String>) =
        update { AutolisterGroups.split(it, groupId, photoIds, UUID.randomUUID().toString()) }

    fun mergeGroups(intoId: String, fromId: String) = update { AutolisterGroups.merged(it, intoId, fromId) }

    fun moveToGroup(photoIds: List<String>, groupId: String) = update { AutolisterGroups.moved(it, photoIds, groupId) }

    fun ungroup(groupId: String) = update { AutolisterGroups.ungrouped(it, groupId) }

    fun setCover(groupId: String, photoId: String) = update { AutolisterGroups.withCover(it, groupId, photoId) }

    fun removePhoto(photoId: String) = update { AutolisterGroups.withoutPhoto(it, photoId) }

    fun dismissError() {
        _state.value = _state.value.copy(errorMessage = null, sentPhotoCount = null)
    }

    /**
     * Hand the batch to the desktop.
     *
     * On success the local session is cleared and a NEW one started: the
     * photos now belong to a server row the desktop will claim, and keeping a
     * local copy would let the same batch be sent twice.
     */
    fun sendToDesktop() {
        if (!_state.value.canSend) return
        _state.value = _state.value.copy(busy = Busy.SENDING, errorMessage = null)
        viewModelScope.launch {
            runCatching { service.createHandoff(AutolisterGroups.handoff(_state.value.session)) }
                .onSuccess { created ->
                    _state.value = _state.value.copy(
                        session = newSession(),
                        sentPhotoCount = created.photoCount,
                    )
                    persist()
                    refreshWaiting()
                }
                .onFailure {
                    _state.value = _state.value.copy(errorMessage = service.message(it))
                }
            _state.value = _state.value.copy(busy = null)
        }
    }

    /** Throw away a batch on the shelf, sweeping its staged files with it. */
    fun discardWaiting(id: String) {
        viewModelScope.launch {
            runCatching { service.discardHandoff(id) }
                .onFailure { _state.value = _state.value.copy(errorMessage = service.message(it)) }
            refreshWaiting()
        }
    }

    /** Start over. The staged files stay on the server until swept. */
    fun clearSession() = update { newSession() }

    private fun newSession() = AutolisterSessionState(
        stagingSessionId = UUID.randomUUID().toString(),
        createdAt = System.currentTimeMillis(),
    )

    /**
     * Apply a pure edit and persist it.
     *
     * One path for every change, so no edit can reach the screen without also
     * reaching the disk.
     */
    private fun update(transform: (AutolisterSessionState) -> AutolisterSessionState) {
        _state.value = _state.value.copy(session = transform(_state.value.session))
        viewModelScope.launch { persist() }
    }

    private suspend fun persist() {
        runCatching {
            db.autolisterSessions().upsert(
                AutolisterSessionEntity(
                    id = SESSION_ID,
                    stateJson = json.encodeToString(
                        AutolisterSessionState.serializer(),
                        _state.value.session,
                    ),
                    updatedAt = System.currentTimeMillis(),
                ),
            )
        }
    }

    private companion object {
        /** One in-flight batch — see AutolisterSessionEntity. */
        const val SESSION_ID = "active"
        val UPLOAD_FAILED = UiMessage(R.string.autolister_upload_failed)
        val json = Json {
            ignoreUnknownKeys = true
            encodeDefaults = true
        }
    }
}
