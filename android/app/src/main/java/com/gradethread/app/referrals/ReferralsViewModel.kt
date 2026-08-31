package com.gradethread.app.referrals

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1385: the referrals screen.
 *
 * Read the code, share it, and apply someone else's. Every derived number lives
 * in [Referrals] so the arithmetic a seller will check against their credit
 * balance is checkable without a device.
 */
@HiltViewModel
class ReferralsViewModel @Inject constructor(private val service: ReferralProviding) : ViewModel() {

    data class State(
        val loading: Boolean = false,
        val me: ReferralMe? = null,
        val loadError: String? = null,
        val typedCode: String = "",
        val redeeming: Boolean = false,
        /**
         * US-2976: a [UiMessage] because the two halves have different owners.
         * The edge's own refusal is the useful one when there is one; ours only
         * runs when it said nothing, and only ours can be translated.
         */
        val redeemError: UiMessage? = null,
        val redeemed: Boolean = false,
    ) {
        val link: String? get() = Referrals.link(me?.code)
        val shareParts: Pair<String, String>? get() = Referrals.shareParts(me?.code)
        val inProgress: Int get() = Referrals.inProgress(me?.stats ?: ReferralStats())
        val alreadyReferred: Boolean get() = Referrals.alreadyReferred(me)
        val canRedeem: Boolean get() = Referrals.canRedeem(me, typedCode, redeeming)

        /**
         * Nothing to share yet.
         *
         * Distinct from a failed load: the endpoint mints a code on first read,
         * so an empty one means something odd happened rather than "you have no
         * referrals". Showing a share button over an empty link would send a
         * broken URL to someone's friend.
         */
        val locked: Boolean get() = me != null && me.code.isBlank()
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /** Re-entrancy guard: a pull-to-refresh landing on top of the first load. */
    private var loading = false

    fun load() {
        if (loading) return
        loading = true
        _state.value = _state.value.copy(loading = true, loadError = null)
        viewModelScope.launch {
            runCatching { service.me() }.fold(
                onSuccess = { me ->
                    _state.value = _state.value.copy(loading = false, me = me)
                },
                onFailure = { error ->
                    _state.value = _state.value.copy(
                        loading = false,
                        loadError = (error as? EdgeApiError)?.userMessage()
                            ?: "Couldn't load your referral code.",
                    )
                },
            )
            loading = false
        }
    }

    fun setTypedCode(value: String) {
        _state.value = _state.value.copy(typedCode = value, redeemError = null)
    }

    fun redeem() {
        val current = _state.value
        if (!current.canRedeem) return
        _state.value = current.copy(redeeming = true, redeemError = null)
        viewModelScope.launch {
            runCatching { service.redeem(Referrals.normalize(current.typedCode)) }.fold(
                onSuccess = { result ->
                    if (result.ok) {
                        Telemetry.event("referral_redeemed", emptyMap())
                        _state.value = _state.value.copy(
                            redeeming = false,
                            redeemed = true,
                            typedCode = "",
                        )
                        // Reload so the "you were referred" state is the
                        // SERVER's, not one we assumed on its behalf.
                        loading = false
                        load()
                    } else {
                        _state.value = _state.value.copy(
                            redeeming = false,
                            redeemError = UiMessage(RedeemRejection.message(result.reason)),
                        )
                    }
                },
                onFailure = { error ->
                    // A thrown error is auth or infrastructure, never the code.
                    _state.value = _state.value.copy(
                        redeeming = false,
                        redeemError = UiMessage(
                            R.string.referral_redeem_failed,
                            (error as? EdgeApiError)?.userMessage(),
                        ),
                    )
                },
            )
        }
    }

    fun dismissRedeemed() {
        _state.value = _state.value.copy(redeemed = false)
    }
}
