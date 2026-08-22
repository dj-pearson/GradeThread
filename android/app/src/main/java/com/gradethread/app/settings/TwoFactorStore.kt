package com.gradethread.app.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.auth.mfa.FactorType
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-2685: TOTP enrollment AND elevation on Android.
 *
 * A workspace member whose owner turned on the 2FA policy
 * (`workspace_mfa_required`) is denied on EVERY request until their session
 * reaches `aal2`. Before this there was no TOTP surface anywhere in the Android
 * app, so an Android-only reseller had nowhere on device to get there.
 *
 * ELEVATION IS NOT THE SAME AS ENROLLMENT, and it is the criterion the iOS twin
 * (US-2671) nearly shipped without. The edge does not check whether a factor
 * EXISTS; it checks the session's assurance level. Password sign-in mints an
 * `aal1` token no matter how many verified factors the account has, so a member
 * who enrolled last week signs in cold today and is blocked again — with an
 * "Enabled" badge on screen telling them otherwise. A verified factor on an
 * aal1 session must offer a code box.
 *
 * RECOVERY CODES ARE DELIBERATELY ABSENT (AC6). They are one-time backups for
 * losing THIS phone, so minting them on the device they protect is not a backup.
 * The screen says where they live instead.
 */
@HiltViewModel
class TwoFactorStore @Inject constructor(
    private val client: SupabaseClient,
) : ViewModel() {

    /**
     * What the user is looking at.
     *
     * `aal2` rides on [Phase.Enabled] because the policy gate is the session's
     * ASSURANCE LEVEL, not the presence of a factor — see the class comment.
     */
    sealed interface Phase {
        data object Loading : Phase

        /** No verified factor. The screen offers enrollment. */
        data object Disabled : Phase

        /** A factor exists but is unverified: show the QR and the code box. */
        data class Enrolling(
            val factorId: String,
            val secret: String,
            val uri: String,
        ) : Phase

        /**
         * A verified factor exists. [aal2] says whether THIS session has been
         * elevated with a code yet; false means the member is still blocked.
         */
        data class Enabled(val factorId: String, val aal2: Boolean) : Phase

        data class Failed(val message: String) : Phase
    }

    data class State(
        val phase: Phase = Phase.Loading,
        val busy: Boolean = false,
        val notice: String? = null,
        val error: String? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    init {
        refresh()
    }

    /** Read the factor list and this session's assurance level together. */
    fun refresh() {
        viewModelScope.launch {
            _state.update { it.copy(busy = true, error = null) }
            runCatching {
                val factors = client.auth.mfa.retrieveFactorsForCurrentUser()
                val verified = factors.firstOrNull { it.isVerified }
                val level = client.auth.mfa.getAuthenticatorAssuranceLevel()
                verified to (level.current == io.github.jan.supabase.auth.mfa.AuthenticatorAssuranceLevel.AAL2)
            }.fold(
                onSuccess = { (verified, isAal2) ->
                    _state.update {
                        it.copy(
                            busy = false,
                            phase = if (verified == null) {
                                Phase.Disabled
                            } else {
                                Phase.Enabled(verified.id, isAal2)
                            },
                        )
                    }
                },
                onFailure = { e ->
                    // A read failure must not render as "two-factor is off" —
                    // that would invite a member to enroll a second factor they
                    // already have, and hide the fact that they are blocked.
                    _state.update {
                        it.copy(busy = false, phase = Phase.Failed(READ_FAILED), error = null)
                    }
                    report(e)
                },
            )
        }
    }

    /** Start enrollment: mint an unverified TOTP factor and show its secret. */
    fun enroll() {
        if (_state.value.busy) return
        viewModelScope.launch {
            _state.update { it.copy(busy = true, error = null, notice = null) }
            runCatching {
                client.auth.mfa.enroll(FactorType.TOTP) {
                    issuer = ISSUER
                }
            }.fold(
                onSuccess = { factor ->
                    _state.update {
                        it.copy(
                            busy = false,
                            phase = Phase.Enrolling(
                                factorId = factor.id,
                                secret = factor.data.secret,
                                uri = factor.data.uri,
                            ),
                        )
                    }
                },
                onFailure = { e ->
                    _state.update { it.copy(busy = false, error = ENROLL_FAILED) }
                    report(e)
                },
            )
        }
    }

    /**
     * Verify the code that finishes enrollment.
     *
     * Success here BOTH verifies the factor and elevates this session, because
     * a successful challenge-verify is what mints an aal2 token. That is why
     * the phase goes straight to `Enabled(aal2 = true)` rather than to a state
     * that then has to elevate separately.
     */
    fun confirmEnrollment(code: String) = runVerify(
        factorId = (_state.value.phase as? Phase.Enrolling)?.factorId,
        code = code,
    )

    /**
     * AC3: elevate an aal1 session that already has a verified factor.
     *
     * Same call, different entry point. Kept as its own function so the screen
     * can label it honestly — the user is not enrolling anything and telling
     * them they are would be a second lie on top of the block.
     */
    fun elevate(code: String) = runVerify(
        factorId = (_state.value.phase as? Phase.Enabled)?.factorId,
        code = code,
    )

    private fun runVerify(factorId: String?, code: String) {
        if (factorId == null || _state.value.busy) return
        viewModelScope.launch {
            _state.update { it.copy(busy = true, error = null, notice = null) }
            val outcome = TwoFactorPolicy.challengeAndVerify(
                code = code,
                challenge = { client.auth.mfa.createChallenge(factorId).id },
                verify = { challengeId, entered ->
                    client.auth.mfa.verifyChallenge(
                        factorId = factorId,
                        challengeId = challengeId,
                        code = entered,
                        saveSession = true,
                    )
                },
            )
            when (outcome) {
                TwoFactorPolicy.Outcome.Verified -> {
                    _state.update {
                        it.copy(
                            busy = false,
                            phase = Phase.Enabled(factorId, aal2 = true),
                            notice = TwoFactorPolicy.message(outcome),
                        )
                    }
                }
                else -> {
                    _state.update {
                        it.copy(busy = false, error = TwoFactorPolicy.message(outcome))
                    }
                    if (outcome is TwoFactorPolicy.Outcome.Failed) report(outcome.error)
                }
            }
        }
    }

    /** AC2: remove the factor, so a lost authenticator is recoverable on device. */
    fun remove() {
        val phase = _state.value.phase
        val factorId = when (phase) {
            is Phase.Enabled -> phase.factorId
            is Phase.Enrolling -> phase.factorId
            else -> null
        } ?: return
        if (_state.value.busy) return
        viewModelScope.launch {
            _state.update { it.copy(busy = true, error = null, notice = null) }
            runCatching { client.auth.mfa.unenroll(factorId) }.fold(
                onSuccess = {
                    _state.update {
                        it.copy(busy = false, phase = Phase.Disabled, notice = REMOVED)
                    }
                },
                onFailure = { e ->
                    _state.update { it.copy(busy = false, error = REMOVE_FAILED) }
                    report(e)
                },
            )
        }
    }

    fun clearMessages() = _state.update { it.copy(error = null, notice = null) }

    private fun report(e: Throwable) {
        // The raw GoTrue sentence goes to the tracker, never to the user.
        io.sentry.Sentry.captureException(e)
    }

    private companion object {
        const val ISSUER = "GradeThread"
        const val READ_FAILED =
            "We couldn't check your two-factor status. Pull to refresh, or try again in a moment."
        const val ENROLL_FAILED =
            "We couldn't start two-factor setup. Try again in a moment."
        const val REMOVE_FAILED =
            "We couldn't turn two-factor off. Try again in a moment."
        const val REMOVED = "Two-factor authentication is off."
    }
}
