package com.gradethread.app.grading

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.platform.net.EdgeApiError
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1337: the stored grade report for one item, plus its integrity verdict.
 */
@HiltViewModel
class GradeReportViewModel @Inject constructor(
    private val repository: ItemGradeReportRepository,
    private val integrity: CertIntegrityService,
) : ViewModel() {

    data class State(
        val itemId: String? = null,
        val loading: Boolean = true,
        val loaded: LoadedGradeReport? = null,
        val verification: CertVerification = CertVerification.Verifying,
        val errorMessage: String? = null,
    ) {
        /**
         * US-1409: a certificate only ever exists on a FINALIZED grade, so its
         * presence — not the raw confidence — decides shareability.
         */
        val isPendingReview: Boolean
            get() = loaded?.let {
                GradeScale.isPendingReview(it.certificateUrl, it.report.confidenceScore)
            } ?: false

        /**
         * The share CTA appears only for a certified grade whose integrity
         * check PASSED. A tampered or unverifiable certificate must not be
         * forwarded to a buyer under our name — that is the one action that
         * turns our problem into someone else's.
         */
        val canShare: Boolean
            get() = !isPendingReview &&
                !loaded?.certificateUrl.isNullOrBlank() &&
                verification.isVerified
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun bind(itemId: String) {
        if (_state.value.itemId == itemId) return
        _state.value = State(itemId = itemId)
        load()
    }

    fun load() {
        val itemId = _state.value.itemId ?: return
        _state.value = _state.value.copy(loading = true, errorMessage = null)
        viewModelScope.launch {
            runCatching { repository.load(itemId) }
                .onSuccess { loaded ->
                    _state.value = _state.value.copy(loading = false, loaded = loaded)
                    // Verification runs after the report is on screen: the
                    // report is readable while the badge resolves, and a slow
                    // verify endpoint never delays the content.
                    loaded?.certificateUrl?.let { verify() }
                        ?: run {
                            _state.value = _state.value.copy(
                                verification = CertVerification.Unavailable,
                            )
                        }
                }
                .onFailure { error ->
                    _state.value = _state.value.copy(
                        loading = false,
                        errorMessage = (error as? EdgeApiError)?.userMessage()
                            ?: error.message
                            ?: "Couldn't load this grade report.",
                    )
                }
        }
    }

    fun verify() {
        val url = _state.value.loaded?.certificateUrl ?: return
        _state.value = _state.value.copy(verification = CertVerification.Verifying)
        viewModelScope.launch {
            _state.value = _state.value.copy(verification = integrity.verify(url))
        }
    }
}
