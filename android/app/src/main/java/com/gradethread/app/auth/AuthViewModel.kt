package com.gradethread.app.auth

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
 * US-2369: the sign-in / sign-up form.
 *
 * Every rule lives in [AuthFormRules] so it is testable; this holds the fields
 * and drives [AuthRepository]. The repository already classifies failures into
 * [FriendlyAuthError], which has been complete and unused by any UI since
 * US-1310 — this is the first surface that reads it.
 */
@HiltViewModel
class AuthViewModel @Inject constructor(
    private val auth: AuthRepository,
) : ViewModel() {

    data class State(
        val mode: AuthFormRules.Mode = AuthFormRules.Mode.SIGN_IN,
        val email: String = "",
        val password: String = "",
        val fullName: String = "",
        val busy: Boolean = false,
        val error: FriendlyAuthError? = null,
        /** A one-off confirmation, e.g. "we've sent that link again". */
        val notice: String? = null,
        /**
         * US-2792: the solved Turnstile token, sent as gotrue's captcha_token.
         *
         * Null covers three situations on purpose, none of which should stop
         * someone signing up: no site key is configured (dev, CI, any build
         * without the secret), the widget has not finished, or it failed.
         * GoTrue is the authority either way - it only rejects a missing token
         * in an environment where captcha is actually switched on.
         */
        val captchaToken: String? = null,
    ) {
        /** Only once they have typed something — an error on an empty field nags. */
        val emailError: String?
            get() = email.takeIf { it.isNotEmpty() }?.let(AuthFormRules::emailError)

        val passwordError: String?
            get() = password.takeIf { it.isNotEmpty() }
                ?.let { AuthFormRules.passwordError(it, mode) }

        val canSubmit: Boolean get() = AuthFormRules.canSubmit(email, password, mode, busy)

        val recovery: AuthFormRules.Recovery get() = AuthFormRules.recovery(error)

        val errorMessage: String? get() = error?.message()

        val isSignUp: Boolean get() = mode == AuthFormRules.Mode.SIGN_UP

        val strength: Int get() = AuthFormRules.strength(password)
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            auth.lastError.collect { error ->
                _state.value = _state.value.copy(error = error, busy = false)
            }
        }
    }

    /**
     * Switch between signing in and signing up.
     *
     * The email is KEPT and the password cleared. Someone who typed their
     * address and then realised they need an account should not retype it; the
     * password field is cleared because the rules differ between modes and a
     * carried-over value would sit there failing validation with no explanation
     * of what changed.
     */
    fun toggleMode() {
        val next = AuthFormRules.toggled(_state.value.mode)
        _state.value = _state.value.copy(
            mode = next,
            password = "",
            error = null,
            notice = null,
            // US-2792: single-use, and the widget remounts on the way back.
            // Keeping it would send a consumed token on the next attempt.
            captchaToken = null,
        )
        auth.clearError()
    }

    fun setEmail(value: String) = update { it.copy(email = value, error = null, notice = null) }

    fun setPassword(value: String) =
        update { it.copy(password = value, error = null, notice = null) }

    fun setFullName(value: String) = update { it.copy(fullName = value) }

    /**
     * US-2792: record the challenge outcome.
     *
     * DELIBERATELY DOES NOT GATE THE BUTTON. Making canSubmit wait on a token
     * would let a wedged widget lock signup completely, on a screen with no
     * way past it - worse than one rejected attempt, since Turnstile solves in
     * about a second and the form takes longer than that to fill. A rejection
     * surfaces through the existing error collector and the widget issues a
     * fresh token for the retry.
     *
     * Failed and NotConfigured both CLEAR the token rather than leaving a
     * stale one. Turnstile tokens are single-use, so a token carried into a
     * second attempt fails validation while looking like it was sent - which
     * is harder to diagnose than sending none.
     */
    fun setCaptcha(result: TurnstileResult) = update {
        it.copy(
            captchaToken = when (result) {
                is TurnstileResult.Token -> result.token
                is TurnstileResult.Failed -> null
                TurnstileResult.NotConfigured -> null
            },
        )
    }

    fun submit() {
        val current = _state.value
        if (!current.canSubmit) return
        _state.value = current.copy(busy = true, error = null, notice = null)
        viewModelScope.launch {
            if (current.isSignUp) {
                auth.signUp(
                    email = current.email.trim(),
                    password = current.password,
                    fullName = current.fullName.trim().takeIf { it.isNotEmpty() },
                    captchaToken = current.captchaToken,
                )
                Telemetry.event("auth_sign_up_attempt", emptyMap())
            } else {
                auth.signIn(email = current.email.trim(), password = current.password)
                Telemetry.event("auth_sign_in_attempt", emptyMap())
            }
            // Busy clears here as well as in the error collector: a SUCCESS
            // emits no error, so waiting for one would leave the button stuck
            // on "Signing in…" until the phase change tore the screen down.
            _state.value = _state.value.copy(busy = false)
        }
    }

    fun resendConfirmation() {
        val email = _state.value.email.trim()
        if (email.isEmpty()) return
        viewModelScope.launch {
            _state.value = _state.value.copy(busy = true)
            auth.resendConfirmation(email)
            _state.value = _state.value.copy(
                busy = false,
                notice = "We've sent that confirmation link again to $email.",
            )
        }
    }

    fun resetPassword() {
        val email = _state.value.email.trim()
        if (email.isEmpty()) return
        viewModelScope.launch {
            _state.value = _state.value.copy(busy = true)
            auth.resetPassword(email)
            _state.value = _state.value.copy(
                busy = false,
                // Deliberately does not say whether the account exists: that
                // would turn this form into an account-existence oracle.
                notice = "If there's an account for $email, we've sent a reset link.",
            )
        }
    }

    fun dismissNotice() = update { it.copy(notice = null) }

    private fun update(transform: (State) -> State) {
        _state.value = transform(_state.value)
    }
}
