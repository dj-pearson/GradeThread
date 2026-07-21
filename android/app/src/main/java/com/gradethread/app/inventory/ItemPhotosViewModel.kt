package com.gradethread.app.inventory

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.work.WorkManager
import com.gradethread.app.capture.PhotoImport
import com.gradethread.app.capture.PhotoSlotType
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.ItemPhotoEntity
import com.gradethread.app.upload.UploadWorker
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.io.File
import javax.inject.Inject

/**
 * US-1344: the canvas photos section.
 *
 * Reorders are applied to a LOCAL working list first so a drag feels
 * immediate, then persisted; the Room flow re-emits the confirmed order
 * afterwards. A failed persist restores the working list from Room rather than
 * leaving the seller looking at an order the server never accepted.
 */
@HiltViewModel
class ItemPhotosViewModel @Inject constructor(
    private val db: GradeThreadDb,
    private val repository: ItemPhotoRepository,
    @ApplicationContext private val context: Context,
) : ViewModel() {

    private val itemIdFlow = MutableStateFlow<String?>(null)

    @Suppress("OPT_IN_USAGE")
    val photos: StateFlow<List<ItemPhotoEntity>> = itemIdFlow
        .flatMapLatest { id ->
            if (id == null) flowOf(emptyList()) else db.photos().observeForItem(id)
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    data class State(
        val working: List<ItemPhotoEntity>? = null,
        val busy: Boolean = false,
        val errorMessage: String? = null,
        val duplicatedItemId: String? = null,
        val deleted: Boolean = false,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun bind(itemId: String) {
        if (itemIdFlow.value == itemId) return
        itemIdFlow.value = itemId
        _state.value = State()
    }

    /** The order to render: the in-progress drag, else the confirmed order. */
    fun displayed(confirmed: List<ItemPhotoEntity>): List<ItemPhotoEntity> =
        _state.value.working ?: PhotoOrdering.displayOrder(confirmed)

    fun move(confirmed: List<ItemPhotoEntity>, from: Int, to: Int) {
        val current = displayed(confirmed)
        _state.value = _state.value.copy(working = PhotoOrdering.moved(current, from, to))
    }

    fun setCover(confirmed: List<ItemPhotoEntity>, index: Int) {
        val current = displayed(confirmed)
        _state.value = _state.value.copy(working = PhotoOrdering.movedToCover(current, index))
        commitOrder()
    }

    /** Persist the working order. */
    fun commitOrder() {
        val ordered = _state.value.working ?: return
        if (_state.value.busy) return
        _state.value = _state.value.copy(busy = true, errorMessage = null)
        viewModelScope.launch {
            repository.persistOrder(ordered)
                .onSuccess {
                    // Cleared so the Room flow becomes the source of truth
                    // again; leaving it set would pin the strip to a snapshot.
                    _state.value = _state.value.copy(busy = false, working = null)
                    Telemetry.event("item_photos_reordered", mapOf("count" to ordered.size))
                }
                .onFailure { error -> fail("Couldn't save that order.", error) }
        }
    }

    fun remove(confirmed: List<ItemPhotoEntity>, photoId: String) {
        if (_state.value.busy) return
        val remaining = PhotoOrdering.removed(displayed(confirmed), photoId)
        _state.value = _state.value.copy(busy = true, errorMessage = null, working = remaining)
        viewModelScope.launch {
            repository.remove(photoId, remaining)
                .onSuccess { _state.value = _state.value.copy(busy = false, working = null) }
                .onFailure { error -> fail("Couldn't remove that photo.", error) }
        }
    }

    /**
     * Add photos from the library into the next free slots.
     *
     * Routed through [UploadWorker] — the same secure pipeline the capture flow
     * uses (magic-byte validation, EXIF strip, deterministic row id, bucket
     * routing), rather than a second upload path that would have to re-earn all
     * of it.
     */
    fun add(itemId: String, uris: List<android.net.Uri>, confirmed: List<ItemPhotoEntity>) {
        if (uris.isEmpty()) return
        _state.value = _state.value.copy(busy = true, errorMessage = null)
        viewModelScope.launch {
            runCatching {
                val outputDir = File(context.cacheDir, "canvas-add")
                val imported = PhotoImport.importPicked(context, uris, outputDir)
                    .mapNotNull { it.getOrNull() }

                // Unfilled standard slots first, then extras. A new photo never
                // takes sort_order 0 — silently changing a live listing's main
                // image is not something anyone asked for.
                val slots = PhotoOrdering.unfilledStandardSlots(confirmed).toMutableList()
                var order = PhotoOrdering.nextSortOrder(confirmed)
                val work = WorkManager.getInstance(context)

                imported.forEach { photo ->
                    val slot = slots.removeFirstOrNull() ?: PhotoSlotType.DETAIL
                    work.enqueue(
                        UploadWorker.request(
                            stagedPath = photo.processed.file.absolutePath,
                            itemId = itemId,
                            serverType = slot.serverPhotoType,
                            sortOrder = order,
                            capturedAt = photo.captureDateMs,
                            width = photo.processed.width,
                            height = photo.processed.height,
                        ),
                    )
                    order++
                }
                imported.size
            }.onSuccess { count ->
                _state.value = _state.value.copy(busy = false)
                Telemetry.event("item_photos_added", mapOf("count" to count))
            }.onFailure { error -> fail("Couldn't add those photos.", error) }
        }
    }

    fun duplicateItem(itemId: String) {
        if (_state.value.busy) return
        _state.value = _state.value.copy(busy = true, errorMessage = null)
        viewModelScope.launch {
            repository.duplicate(itemId)
                .onSuccess { newId ->
                    _state.value = _state.value.copy(busy = false, duplicatedItemId = newId)
                }
                .onFailure { error -> fail("Couldn't duplicate this item.", error) }
        }
    }

    fun deleteItem(itemId: String) {
        if (_state.value.busy) return
        _state.value = _state.value.copy(busy = true, errorMessage = null)
        viewModelScope.launch {
            repository.deleteItem(itemId)
                .onSuccess { _state.value = _state.value.copy(busy = false, deleted = true) }
                .onFailure { error -> fail("Couldn't delete this item.", error) }
        }
    }

    fun onNavigated() {
        _state.value = _state.value.copy(duplicatedItemId = null)
    }

    fun dismissError() {
        _state.value = _state.value.copy(errorMessage = null)
    }

    /** Drop the optimistic order so Room's confirmed one shows again. */
    private fun fail(message: String, error: Throwable) {
        _state.value = _state.value.copy(
            busy = false,
            working = null,
            errorMessage = error.message?.let { "$message ($it)" } ?: message,
        )
    }
}
