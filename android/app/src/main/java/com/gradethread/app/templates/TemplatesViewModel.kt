package com.gradethread.app.templates

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
 * US-1373: the template list and its editor.
 */
@HiltViewModel
class TemplatesViewModel @Inject constructor(
    private val service: TemplateProviding,
) : ViewModel() {

    data class State(
        val templates: List<ListingTemplate> = emptyList(),
        val loading: Boolean = false,
        val loaded: Boolean = false,
        val saving: Boolean = false,
        val editing: TemplateDraft? = null,
        val editingId: String? = null,
        val deleting: ListingTemplate? = null,
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
                        templates = TemplateApply.ordered(rows),
                        loading = false,
                        loaded = true,
                    )
                },
                onFailure = { error ->
                    // The list already on screen stays put — a failed refresh
                    // is no reason to make someone's templates vanish.
                    _state.value = _state.value.copy(
                        loading = false,
                        errorMessage = friendly(error),
                    )
                },
            )
        }
    }

    fun startCreate() {
        _state.value = _state.value.copy(
            // A new template sorts after the existing ones rather than jumping
            // to the top of everyone's picker.
            editing = TemplateDraft(sortOrder = _state.value.templates.size),
            editingId = null,
            errorMessage = null,
        )
    }

    fun startEdit(template: ListingTemplate) {
        _state.value = _state.value.copy(
            editing = TemplateDraft.of(template),
            editingId = template.id,
            errorMessage = null,
        )
    }

    fun editDraft(transform: (TemplateDraft) -> TemplateDraft) {
        val current = _state.value.editing ?: return
        _state.value = _state.value.copy(editing = transform(current), errorMessage = null)
    }

    fun cancelEdit() {
        _state.value = _state.value.copy(editing = null, editingId = null)
    }

    fun save() {
        val draft = _state.value.editing ?: return
        if (!draft.isValid) {
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
                        if (id == null) "template.created" else "template.updated",
                        mapOf("specifics" to saved.itemSpecifics.size),
                    )
                    _state.value = _state.value.copy(
                        templates = merge(_state.value.templates, saved),
                        saving = false,
                        editing = null,
                        editingId = null,
                    )
                },
                onFailure = { error ->
                    // The sheet stays open with the typing intact. Closing it on
                    // a failure would throw away a description block someone may
                    // have spent five minutes on.
                    _state.value = _state.value.copy(saving = false, errorMessage = friendly(error))
                },
            )
        }
    }

    fun confirmDelete(template: ListingTemplate) {
        _state.value = _state.value.copy(deleting = template)
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
                    Telemetry.event("template.deleted")
                    _state.value = _state.value.copy(
                        templates = _state.value.templates.filterNot { it.id == target.id },
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

    /**
     * Marking one default un-marks the rest LOCALLY too.
     *
     * The RPC already did it server-side in the same transaction; without this
     * the list would show two defaults until the next refresh, and a seller
     * would reasonably conclude the toggle didn't work.
     */
    private fun merge(existing: List<ListingTemplate>, saved: ListingTemplate): List<ListingTemplate> {
        val others = existing
            .filterNot { it.id == saved.id }
            .map { if (saved.isDefault) it.copy(isDefault = false) else it }
        return TemplateApply.ordered(others + saved)
    }

    private fun friendly(error: Throwable): String {
        val text = error.message.orEmpty()
        return when {
            text.contains("23505") || text.contains("duplicate key", ignoreCase = true) ->
                "You already have a template with that name."
            text.contains("28000") || text.contains("not authenticated", ignoreCase = true) ->
                "Sign in again to save templates."
            else -> text.ifBlank { "Couldn't save that template." }
        }
    }
}
