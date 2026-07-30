package com.gradethread.app.marketplaces.publish

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.sync.db.GradeThreadDb
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.Locale
import javax.inject.Inject

/**
 * US-1352: the publish composer.
 *
 * Save the draft → validate → review → push. The save is not optional: publish
 * assembles what it sends to eBay from the `listings` row, so an unsaved
 * composer edit would be silently dropped (see [ListingDraftService]).
 */
@HiltViewModel
class PublishViewModel @Inject constructor(
    private val drafts: ListingDraftService,
    private val publish: EbayPublishService,
    private val db: GradeThreadDb,
) : ViewModel() {

    data class State(
        val itemId: String = "",
        val loading: Boolean = true,
        val phase: PublishPhase = PublishPhase.Composing,
        val title: String = "",
        val priceText: String = "",
        val condition: EbayCondition = EbayCondition.USED_EXCELLENT,
        val conditionDescription: String = "",
        /** What the item cost, for the profit estimate. Null = unknown. */
        val costBasis: Double? = null,
        /** True when the item has been on eBay before, so publish means relist. */
        val relist: Boolean = false,
        val errorMessage: String? = null,
    ) {
        /**
         * Live estimate at the price currently typed. Recomputed from the
         * composer text, not from the saved draft, so the number moves as the
         * seller edits — which is the entire point of showing it.
         */
        val profit: ListingProfit
            get() = ListingProfit.estimate(
                price = ListingDraftService.validatedPrice(priceText) ?: 0.0,
                costBasis = costBasis,
            )

        val busy: Boolean get() = PublishFlow.isBusy(phase)
        val canPublish: Boolean get() = PublishFlow.canPublish(phase) && !busy
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /**
     * Loads the item and its existing eBay draft, then runs pre-flight once so
     * the seller sees the blockers before typing anything.
     */
    fun bind(itemId: String) {
        if (_state.value.itemId == itemId && !_state.value.loading) return
        _state.value = State(itemId = itemId)
        viewModelScope.launch {
            val item = db.items().byId(itemId)
            val draft = runCatching { drafts.existingDraft(itemId) }.getOrNull()
            _state.value = _state.value.copy(
                loading = false,
                // The SAVED DRAFT wins the prefill. A title the seller already
                // tuned (or AutoLister wrote) must survive reopening the
                // composer; falling back to the item title would undo it.
                title = draft?.title?.takeIf { it.isNotBlank() } ?: item?.title.orEmpty(),
                priceText = (draft?.price ?: item?.listingPrice ?: item?.targetPrice)
                    ?.takeIf { it > 0 }
                    ?.let { String.format(Locale.US, "%.2f", it) }
                    .orEmpty(),
                condition = EbayCondition.resolve(draft?.condition),
                conditionDescription = draft?.conditionDescription.orEmpty(),
                costBasis = item?.acquiredPrice,
                relist = draft?.needsRelist == true,
            )
            validate()
        }
    }

    fun editTitle(value: String) {
        _state.value = _state.value.copy(title = value)
    }

    fun editPrice(value: String) {
        _state.value = _state.value.copy(priceText = value)
    }

    fun editCondition(value: EbayCondition) {
        _state.value = _state.value.copy(condition = value)
    }

    fun editConditionDescription(value: String) {
        _state.value = _state.value.copy(conditionDescription = value)
    }

    fun dismissError() {
        _state.value = _state.value.copy(errorMessage = null)
    }

    /** Save the composer's edits, then run pre-flight against the saved draft. */
    fun validate() {
        val state = _state.value
        if (state.busy || state.itemId.isBlank()) return
        _state.value = state.copy(phase = PublishPhase.Validating, errorMessage = null)

        viewModelScope.launch {
            val saved = runCatching {
                drafts.save(
                    state.itemId,
                    ListingDraftService.Draft(
                        title = state.title,
                        priceText = state.priceText,
                        condition = state.condition,
                        conditionDescription = state.conditionDescription,
                    ),
                )
            }
            if (saved.isFailure) {
                // Stay in Composing, not Failed: the draft was never sent, so
                // the fix is in the field the seller is looking at.
                _state.value = _state.value.copy(
                    phase = PublishPhase.Composing,
                    errorMessage = saved.exceptionOrNull()?.message
                        ?: "Couldn't save the listing draft.",
                )
                return@launch
            }
            _state.value = _state.value.copy(
                phase = PublishFlow.afterValidate(publish.validate(state.itemId)),
            )
        }
    }

    /**
     * Publish (or relist). Guarded on the phase, so a stale tap after the
     * blockers came back can't push an item pre-flight just rejected.
     */
    fun publishNow() {
        val state = _state.value
        if (!state.canPublish) return
        _state.value = state.copy(phase = PublishPhase.Pushing, errorMessage = null)

        viewModelScope.launch {
            val phase = PublishFlow.afterPush(publish.push(state.itemId, relist = state.relist))
            _state.value = _state.value.copy(phase = phase)
            if (phase is PublishPhase.Published) {
                Telemetry.event(
                    "ebay_listing_published",
                    mapOf("relist" to state.relist, "sync_pending" to phase.result.syncPending),
                )
            }
        }
    }

    /** Back to the composer after a failure, without reopening the sheet. */
    fun backToComposer() {
        _state.value = _state.value.copy(phase = PublishPhase.Composing, errorMessage = null)
    }
}
