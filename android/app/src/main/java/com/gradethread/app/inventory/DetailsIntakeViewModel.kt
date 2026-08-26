package com.gradethread.app.inventory

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.capture.DetailsDraftStore
import com.gradethread.app.capture.DetailsIntakeState
import com.gradethread.app.speech.DictationMerge
import com.gradethread.app.sync.db.GradeThreadDb
import com.gradethread.app.sync.db.SourceEntity
import com.gradethread.app.sync.db.SourcerEntity
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1330: the details intake screen's state holder.
 *
 * Autosave is keyed on [DetailsIntakeState.draftSignature] rather than on
 * every emission, so a recomposition that doesn't change a field writes
 * nothing. Recovery is an explicit PROMPT, never a silent restore — silently
 * repopulating a form the user thought they'd abandoned is how duplicate
 * items get created.
 */
@HiltViewModel
class DetailsIntakeViewModel @Inject constructor(
    private val repository: IntakeRepository,
    private val sourcers: SourcerRepository,
    private val db: GradeThreadDb,
) : ViewModel() {

    data class UiState(
        val form: DetailsIntakeState = DetailsIntakeState(),
        val sources: List<SourceEntity> = emptyList(),
        /** US-2886: the "Sourced by" roster. */
        val sourcerRoster: List<SourcerEntity> = emptyList(),
        val saving: Boolean = false,
        /** A recovered draft awaiting resume/discard. Null = no prompt. */
        val pendingDraft: DetailsIntakeState? = null,
        val merge: MergePrompt? = null,
        val banner: Banner? = null,
        /** Shown only after a save attempt, so the form isn't red on open. */
        val showValidation: Boolean = false,
    )

    data class MergePrompt(
        val existing: IntakeSubmission.ExistingItem,
        val conflicts: List<ItemMergePlan.Conflict>,
        val keepExisting: Set<ItemMergePlan.Field>,
    )

    data class Banner(val message: String, val isError: Boolean)

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    /** Guards autosave: only write when the signature actually moved. */
    private var lastSavedSignature: String? = null

    init {
        viewModelScope.launch {
            val sources = runCatching { repository.sources() }.getOrDefault(emptyList())
            val roster = runCatching { sourcers.roster() }.getOrDefault(emptyList())
            val draft = runCatching { DetailsDraftStore.load(db) }.getOrNull()
            _state.value = _state.value.copy(
                sources = sources,
                sourcerRoster = roster,
                pendingDraft = draft,
            )
        }
    }

    /**
     * US-2886: add a person to the roster, then hand the caller the name to
     * select. `null` means nothing was written — the picker says so rather than
     * selecting a name the server has never heard of.
     */
    fun addSourcer(name: String, onResult: (String?) -> Unit) {
        viewModelScope.launch {
            val saved = runCatching { sourcers.add(name) }.getOrNull()
            if (saved != null) {
                _state.value = _state.value.copy(
                    sourcerRoster = runCatching { sourcers.roster() }
                        .getOrDefault(_state.value.sourcerRoster),
                )
            }
            onResult(saved)
        }
    }

    fun update(transform: (DetailsIntakeState) -> DetailsIntakeState) {
        val next = transform(_state.value.form).clampTitle()
        _state.value = _state.value.copy(form = next)
        autosave(next)
    }

    // ── US-1331: dictation ──────────────────────────────────────────────

    /**
     * The notes contents at the moment dictation started. Every partial
     * merges against THIS, so each one replaces the last rather than
     * concatenating (see DictationMerge).
     */
    private var dictationAnchor: String? = null

    fun beginDictation() {
        dictationAnchor = _state.value.form.notes
    }

    /**
     * Fold a transcript into notes.
     *
     * Partials deliberately DO NOT autosave: they arrive at recognizer
     * cadence (several per second) and `notes` is part of the draft
     * signature, so autosaving each one would hammer Room with a write per
     * syllable. The draft is written once when the final lands, which is the
     * only version worth recovering anyway.
     */
    fun onDictationTranscript(transcript: String, isFinal: Boolean) {
        val anchor = dictationAnchor ?: _state.value.form.notes.also { dictationAnchor = it }
        val merged = DictationMerge.mergeNotes(anchor, transcript)
        val next = _state.value.form.copy(notes = merged)
        _state.value = _state.value.copy(form = next)
        if (isFinal) {
            autosave(next)
            dictationAnchor = null
        }
    }

    /** Dictation ended without a final result — persist what we have. */
    fun endDictation() {
        if (dictationAnchor == null) return
        dictationAnchor = null
        autosave(_state.value.form)
    }

    fun showDictationError(message: String) {
        _state.value = _state.value.copy(banner = Banner(message, isError = true))
    }

    private fun autosave(form: DetailsIntakeState) {
        val signature = form.draftSignature
        if (signature == lastSavedSignature) return
        lastSavedSignature = signature
        viewModelScope.launch {
            // A failed draft write must never surface as an error — the user
            // is mid-typing and the save is best-effort.
            runCatching { DetailsDraftStore.save(db, form) }
        }
    }

    fun resumeDraft() {
        val draft = _state.value.pendingDraft ?: return
        lastSavedSignature = draft.draftSignature
        _state.value = _state.value.copy(form = draft, pendingDraft = null)
    }

    fun discardDraft() {
        _state.value = _state.value.copy(pendingDraft = null)
        lastSavedSignature = null
        viewModelScope.launch { runCatching { DetailsDraftStore.clear(db) } }
    }

    fun dismissBanner() {
        _state.value = _state.value.copy(banner = null)
    }

    /** @param addAnother keep the sourcing context and stay on the form. */
    fun save(addAnother: Boolean = false) {
        val form = _state.value.form
        if (!form.canSubmit) {
            _state.value = _state.value.copy(showValidation = true)
            return
        }
        if (_state.value.saving) return
        _state.value = _state.value.copy(saving = true, showValidation = false)

        viewModelScope.launch {
            when (val outcome = repository.submit(form)) {
                is IntakeSubmission.Outcome.Inserted ->
                    finishSave(addAnother, Banner("Item saved.", isError = false))

                is IntakeSubmission.Outcome.Queued -> finishSave(
                    addAnother,
                    // Named as queued, not failed: the item WILL land.
                    Banner("Saved offline — it'll sync when you're back.", isError = false),
                )

                is IntakeSubmission.Outcome.MergeRequired -> _state.value = _state.value.copy(
                    saving = false,
                    merge = MergePrompt(
                        existing = outcome.existing,
                        conflicts = outcome.conflicts,
                        keepExisting = ItemMergePlan.defaultKeepExisting(outcome.conflicts),
                    ),
                )

                is IntakeSubmission.Outcome.Failed -> _state.value = _state.value.copy(
                    saving = false,
                    banner = Banner(
                        outcome.error.message ?: "Couldn't save this item.",
                        isError = true,
                    ),
                )
            }
        }
    }

    fun toggleMergeChoice(field: ItemMergePlan.Field, keepExisting: Boolean) {
        val merge = _state.value.merge ?: return
        val next = merge.keepExisting.toMutableSet().apply {
            if (keepExisting) add(field) else remove(field)
        }
        _state.value = _state.value.copy(merge = merge.copy(keepExisting = next))
    }

    fun cancelMerge() {
        _state.value = _state.value.copy(merge = null)
    }

    fun confirmMerge(addAnother: Boolean = false) {
        val merge = _state.value.merge ?: return
        val form = _state.value.form
        _state.value = _state.value.copy(saving = true)
        viewModelScope.launch {
            repository.applyMerge(form, merge.existing, merge.keepExisting)
                .onSuccess {
                    _state.value = _state.value.copy(merge = null)
                    finishSave(addAnother, Banner("Combined into the existing item.", false))
                }
                .onFailure { error ->
                    _state.value = _state.value.copy(
                        saving = false,
                        banner = Banner(error.message ?: "Couldn't combine these items.", true),
                    )
                }
        }
    }

    private suspend fun finishSave(addAnother: Boolean, banner: Banner) {
        // The draft's job is done the moment the row is saved or queued.
        runCatching { DetailsDraftStore.clear(db) }
        val next = if (addAnother) {
            _state.value.form.resetForAddAnother()
        } else {
            DetailsIntakeState()
        }
        lastSavedSignature = null
        _state.value = _state.value.copy(
            form = next,
            saving = false,
            merge = null,
            banner = banner,
            showValidation = false,
        )
    }
}
