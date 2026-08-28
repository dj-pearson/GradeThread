package com.gradethread.app.autolister

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-2964: one draft's description blocks.
 *
 * The renderer is edge-only, so this holds the block ARRAY and asks
 * functions.gradethread.com for every string it shows. Nothing here builds a
 * description; [State.preview] is always bytes the server produced, which is
 * what makes a draft edited on a phone and opened on the web show the same
 * thing.
 *
 * Mirrors `src/hooks/use-description-blocks.ts` and the iOS
 * `DescriptionBlocksStore`.
 */
@HiltViewModel
class DescriptionBlocksViewModel @Inject constructor(private val service: DescriptionBlocksService) : ViewModel() {

    data class State(
        val listingId: String? = null,
        /** Starts as the default order so the list can draw before the load. */
        val blocks: List<DescriptionBlock> = DescriptionBlocks.DEFAULTS,
        /** The exact string the marketplace receives, straight from the edge. */
        val preview: String = "",
        val previewPending: Boolean = false,
        val loading: Boolean = false,
        /** These rows came from parsing a legacy description. */
        val converted: Boolean = false,
        /** True once this listing's real blocks have arrived. */
        val hydrated: Boolean = false,
        val regenerating: DescriptionBlockKey? = null,
        val saving: Boolean = false,
        val snippets: List<DescriptionBlocksService.ListingSnippet> = emptyList(),
        val snippetsLoaded: Boolean = false,
        /** The item columns the derived rows' summaries read. */
        val itemFacts: DescriptionBlocksService.ItemFacts? = null,
        val message: String? = null,
    ) {
        /**
         * False while the rows on screen are a placeholder rather than this
         * listing's real blocks. Saving then would render a description out of
         * empty prose and overwrite a real one.
         */
        val ready: Boolean get() = listingId == null || hydrated

        /** The listing has a row but its blocks never arrived. */
        val unavailable: Boolean get() = listingId != null && !hydrated && !loading
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /**
     * The array (and unit) the current [State.preview] was rendered from. Every
     * server response carries BOTH the blocks and their render, so recording it
     * stops the next edit asking for bytes already in hand - which on the first
     * load would replace the byte-for-byte legacy conversion with a second
     * render of it.
     */
    private var previewedBlocks: List<DescriptionBlock>? = null
    private var loadedFor: String? = null
    private var unit: String = "in"

    private data class PreviewPayload(val listingId: String, val blocks: List<DescriptionBlock>, val unit: String)

    private val scheduler by lazy {
        DescriptionPreviewScheduler<PreviewPayload, String>(
            scope = viewModelScope,
            fetcher = { service.preview(it.listingId, it.blocks, it.unit) },
            onResult = { rendered -> _state.value = _state.value.copy(preview = rendered) },
            onPending = { pending -> _state.value = _state.value.copy(previewPending = pending) },
        )
    }

    // ── Load ────────────────────────────────────────────────────────────────

    /** Point the view model at a draft. The load runs once per listing id. */
    fun open(listingId: String, inventoryItemId: String, unit: String = "in") {
        this.unit = unit
        if (loadedFor == listingId) return
        loadedFor = listingId
        _state.value = State(listingId = listingId, loading = true)
        viewModelScope.launch {
            runCatching { service.load(listingId, unit) }
                .onSuccess { response ->
                    // The preview is adopted VERBATIM, not re-rendered.
                    previewedBlocks = response.blocks
                    _state.value = _state.value.copy(
                        blocks = response.blocks,
                        preview = response.preview,
                        converted = response.converted,
                        hydrated = true,
                        loading = false,
                        message = null,
                    )
                }
                .onFailure {
                    // Silent about the network, explicit about the consequence:
                    // the editor switches to its unavailable state, where saving
                    // is refused. A message per failed load would fire on every
                    // offline reopen.
                    loadedFor = null
                    _state.value = _state.value.copy(loading = false)
                }
        }
        loadSnippets()
        loadItemFacts(inventoryItemId)
    }

    private fun loadSnippets() {
        viewModelScope.launch {
            val rows = runCatching { service.snippets() }.getOrDefault(emptyList())
            _state.value = _state.value.copy(snippets = rows, snippetsLoaded = true)
        }
    }

    private fun loadItemFacts(inventoryItemId: String) {
        if (inventoryItemId.isBlank()) return
        viewModelScope.launch {
            val facts = runCatching { service.itemFacts(inventoryItemId) }.getOrNull()
            _state.value = _state.value.copy(itemFacts = facts)
        }
    }

    // ── Edits ───────────────────────────────────────────────────────────────

    fun setBlocks(next: List<DescriptionBlock>) {
        _state.value = _state.value.copy(blocks = next)
        requestPreview()
    }

    fun toggle(index: Int) = setBlocks(DescriptionBlocks.toggle(_state.value.blocks, index))

    fun setText(index: Int, text: String) = setBlocks(DescriptionBlocks.setText(_state.value.blocks, index, text))

    fun move(from: Int, to: Int) = setBlocks(DescriptionBlocks.move(_state.value.blocks, from, to))

    fun addSnippet(ref: String) = setBlocks(DescriptionBlocks.addSnippet(_state.value.blocks, ref))

    fun remove(index: Int) = setBlocks(DescriptionBlocks.remove(_state.value.blocks, index))

    /**
     * Re-render whenever the array changes - EXCEPT when the string for that
     * exact array is already in hand.
     */
    private fun requestPreview() {
        val current = _state.value
        val listingId = current.listingId ?: return
        if (previewedBlocks == current.blocks) return
        previewedBlocks = current.blocks
        scheduler.request(PreviewPayload(listingId, current.blocks, unit))
    }

    override fun onCleared() {
        scheduler.cancel()
        super.onCleared()
    }

    // ── Save and regenerate ─────────────────────────────────────────────────

    /**
     * Persist the current array.
     *
     * [onSaved] receives the rendered description so the caller can put it back
     * into the row it is showing - the route wrote `listing_description` from
     * the blocks, so anything the screen still holds is a render behind.
     */
    fun save(onSaved: (String) -> Unit = {}) {
        val current = _state.value
        val listingId = current.listingId ?: return
        if (!current.ready || current.saving) return
        _state.value = current.copy(saving = true, message = null)
        viewModelScope.launch {
            runCatching { service.save(listingId, current.blocks, unit) }
                .onSuccess { response ->
                    previewedBlocks = response.blocks
                    _state.value = _state.value.copy(
                        blocks = response.blocks,
                        preview = response.description,
                        converted = false,
                        saving = false,
                        message = null,
                    )
                    onSaved(response.description)
                }
                .onFailure {
                    _state.value = _state.value.copy(
                        saving = false,
                        message = "The description sections could not be saved.",
                    )
                }
        }
    }

    /** Rewrite one AI block server-side. */
    fun regenerate(key: DescriptionBlockKey) {
        val current = _state.value
        val listingId = current.listingId ?: return
        if (current.regenerating != null) return
        _state.value = current.copy(regenerating = key, message = null)
        viewModelScope.launch {
            runCatching { service.regenerate(listingId, key, unit) }
                .onSuccess { response ->
                    previewedBlocks = response.blocks
                    _state.value = _state.value.copy(
                        blocks = response.blocks,
                        preview = response.description,
                        regenerating = null,
                        message = null,
                    )
                }
                .onFailure {
                    _state.value = _state.value.copy(
                        regenerating = null,
                        message = "That section could not be rewritten.",
                    )
                }
        }
    }

    /** What a row's one-line summary reads, beyond the block itself. */
    fun rowContext(): DescriptionBlocks.RowContext {
        val current = _state.value
        val facts = current.itemFacts
        return DescriptionBlocks.RowContext(
            attributes = mapOf(
                "brand" to facts?.brand.orEmpty(),
                "size" to facts?.size.orEmpty(),
                "color" to facts?.color.orEmpty(),
                "material" to facts?.material.orEmpty(),
                "style" to facts?.style.orEmpty(),
            ),
            // A stored zero is an unset field, not a measurement of nothing.
            measurementCount = facts?.measurements.orEmpty().count { it.value > 0 },
            unit = unit,
            gradeValue = facts?.gradeValue,
            snippetNames = current.snippets.associate { it.id to it.name },
            snippetsLoaded = current.snippetsLoaded,
        )
    }
}
