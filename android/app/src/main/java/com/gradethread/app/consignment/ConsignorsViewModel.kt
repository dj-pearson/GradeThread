package com.gradethread.app.consignment

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.platform.telemetry.Telemetry
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1372: the consignor list, and the sheet that edits one.
 */
@HiltViewModel
class ConsignorsViewModel @Inject constructor(
    private val service: ConsignorProviding,
) : ViewModel() {

    data class State(
        val consignors: List<Consignor> = emptyList(),
        val loading: Boolean = false,
        val loaded: Boolean = false,
        val saving: Boolean = false,
        /** Non-null while the sheet is open. */
        val editing: ConsignorDraft? = null,
        /** Null when the sheet is creating rather than editing. */
        val editingId: String? = null,
        /** The consignor a delete confirmation is pending for. */
        val deleting: Consignor? = null,
        val errorMessage: String? = null,
    ) {
        val sheetOpen: Boolean get() = editing != null
        val canSave: Boolean get() = editing?.isValid == true && !saving
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun load() {
        if (_state.value.loading) return
        _state.value = _state.value.copy(loading = true, errorMessage = null)
        viewModelScope.launch {
            runCatching { service.list() }.fold(
                onSuccess = { rows ->
                    _state.value = _state.value.copy(
                        consignors = rows,
                        loading = false,
                        loaded = true,
                    )
                },
                onFailure = { error ->
                    _state.value = _state.value.copy(
                        loading = false,
                        // The list already on screen stays. A failed refresh is
                        // not a reason to make someone's consignors disappear.
                        errorMessage = error.message ?: "Couldn't load your consignors.",
                    )
                },
            )
        }
    }

    fun startCreate() {
        _state.value = _state.value.copy(
            editing = ConsignorDraft(),
            editingId = null,
            errorMessage = null,
        )
    }

    fun startEdit(consignor: Consignor) {
        _state.value = _state.value.copy(
            editing = ConsignorDraft.of(consignor),
            editingId = consignor.id,
            errorMessage = null,
        )
    }

    fun editDraft(transform: (ConsignorDraft) -> ConsignorDraft) {
        val current = _state.value.editing ?: return
        _state.value = _state.value.copy(editing = transform(current), errorMessage = null)
    }

    fun cancelEdit() {
        _state.value = _state.value.copy(editing = null, editingId = null)
    }

    fun save() {
        val draft = _state.value.editing ?: return
        if (!draft.isValid) {
            // The reason, not a disabled button with no explanation.
            _state.value = _state.value.copy(errorMessage = draft.validationMessage)
            return
        }
        if (_state.value.saving) return
        val id = _state.value.editingId
        _state.value = _state.value.copy(saving = true, errorMessage = null)

        viewModelScope.launch {
            runCatching {
                if (id == null) service.create(draft) else service.update(id, draft)
            }.fold(
                onSuccess = { saved ->
                    Telemetry.event(
                        if (id == null) "consignor.created" else "consignor.updated",
                    )
                    _state.value = _state.value.copy(
                        consignors = merge(_state.value.consignors, saved),
                        saving = false,
                        editing = null,
                        editingId = null,
                    )
                },
                onFailure = { error ->
                    // The sheet stays OPEN with what they typed still in it.
                    // Closing it on a failure would throw the edit away.
                    _state.value = _state.value.copy(
                        saving = false,
                        errorMessage = friendly(error),
                    )
                },
            )
        }
    }

    fun confirmDelete(consignor: Consignor) {
        _state.value = _state.value.copy(deleting = consignor)
    }

    fun cancelDelete() {
        _state.value = _state.value.copy(deleting = null)
    }

    fun delete() {
        val target = _state.value.deleting ?: return
        _state.value = _state.value.copy(deleting = null, saving = true)
        viewModelScope.launch {
            runCatching { service.delete(target.id) }.fold(
                onSuccess = {
                    Telemetry.event("consignor.deleted")
                    _state.value = _state.value.copy(
                        consignors = _state.value.consignors.filterNot { it.id == target.id },
                        saving = false,
                    )
                },
                onFailure = { error ->
                    _state.value = _state.value.copy(saving = false, errorMessage = friendly(error))
                },
            )
        }
    }

    fun dismissError() {
        _state.value = _state.value.copy(errorMessage = null)
    }

    private fun merge(existing: List<Consignor>, saved: Consignor): List<Consignor> =
        (existing.filterNot { it.id == saved.id } + saved).sortedBy { it.name.lowercase() }

    /**
     * The one server error worth translating.
     *
     * `consignors` has a UNIQUE (user_id, name), and "duplicate key value
     * violates unique constraint" tells a seller nothing about what to do.
     */
    private fun friendly(error: Throwable): String {
        val text = error.message.orEmpty()
        return when {
            text.contains("23505") || text.contains("duplicate key", ignoreCase = true) ->
                "You already have a consignor with that name."
            text.contains("default_split_pct", ignoreCase = true) ->
                "The split has to be between 0 and 100."
            else -> text.ifBlank { "Couldn't save that consignor." }
        }
    }
}
