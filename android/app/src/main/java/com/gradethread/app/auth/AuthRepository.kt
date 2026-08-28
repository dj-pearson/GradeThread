package com.gradethread.app.auth

import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.platform.workspace.WorkspaceScope
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.auth.providers.builtin.Email
import io.github.jan.supabase.auth.status.SessionStatus
import io.github.jan.supabase.auth.user.UserInfo
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Singleton

/**
 * US-1310: the auth store (iOS AuthStore). Tails supabase-kt's session status
 * into a [phase] StateFlow the shell switches on; the session itself restores
 * from EncryptedSharedPreferences (US-1307) so a relaunch lands signed-in
 * without a network round-trip.
 *
 * Carried iOS rules:
 *  - a REFRESH FAILURE is NOT a sign-out (the 1h-boundary incident): the
 *    phase holds; EdgeApi surfaces the transient as a network error;
 *  - sign-out is LOCAL-FIRST (US-1499): local session/state clear + phase →
 *    SignedOut + telemetry clear happen REGARDLESS of network; the server
 *    revoke is best-effort (an airplane-mode user must never be stuck
 *    signed-in);
 *  - sign-out emits [signOutEvents] for the local-data wipe (US-1323:
 *    watermark reset BEFORE row wipe — consumed by the sync stories);
 *  - errors map through [FriendlyAuthError] so the UI can offer the right
 *    recovery (resend confirmation, reset password).
 */
@Singleton
class AuthRepository @Inject constructor(
    private val client: SupabaseClient,
) {

    sealed class Phase {
        object Loading : Phase()
        object SignedOut : Phase()
        data class SignedIn(val userId: String, val email: String?) : Phase()
    }

    private val phaseFlow = MutableStateFlow<Phase>(Phase.Loading)
    val phase: StateFlow<Phase> = phaseFlow

    private val errorFlow = MutableStateFlow<FriendlyAuthError?>(null)
    val lastError: StateFlow<FriendlyAuthError?> = errorFlow

    /** US-1323 consumers: fired on sign-out BEFORE any new sign-in can land. */
    private val signOutFlow = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val signOutEvents: SharedFlow<Unit> = signOutFlow

    /** Tail the SDK's session status. Call once from the app scope. */
    fun start(scope: CoroutineScope) {
        scope.launch {
            client.auth.sessionStatus.collect { status ->
                phaseFlow.value = nextPhase(phaseFlow.value, status.toEvent())
                if (status is SessionStatus.Authenticated) {
                    status.session.user?.id?.let(Telemetry::setUser)
                }
            }
        }
    }

    // ── Pure phase transition (unit-tested) ──────────────────────────────────

    /** SDK-independent mirror of the session events we act on. */
    enum class SessionEvent { INITIALIZING, AUTHENTICATED, NOT_AUTHENTICATED, REFRESH_FAILURE }

    internal data class AuthUser(val id: String, val email: String?)

    private var lastUser: AuthUser? = null

    private fun SessionStatus.toEvent(): SessionEvent = when (this) {
        is SessionStatus.Initializing -> SessionEvent.INITIALIZING
        is SessionStatus.Authenticated -> {
            session.user?.let { lastUser = AuthUser(it.id, it.email) }
            SessionEvent.AUTHENTICATED
        }
        is SessionStatus.NotAuthenticated -> SessionEvent.NOT_AUTHENTICATED
        is SessionStatus.RefreshFailure -> SessionEvent.REFRESH_FAILURE
    }

    internal fun nextPhase(current: Phase, event: SessionEvent): Phase = when (event) {
        SessionEvent.INITIALIZING -> Phase.Loading
        SessionEvent.AUTHENTICATED ->
            lastUser?.let { Phase.SignedIn(it.id, it.email) } ?: current
        SessionEvent.NOT_AUTHENTICATED -> Phase.SignedOut
        // The 1h-boundary rule: a refresh FAILURE is transient, not a
        // sign-out. Holding the phase keeps the user in the app; requests
        // surface network errors until the refresh succeeds or the server
        // definitively rejects the session.
        SessionEvent.REFRESH_FAILURE -> current
    }

    // ── Actions ──────────────────────────────────────────────────────────────

    /**
     * US-2792: start a provider sign-in.
     *
     * Lives here because this class owns the SupabaseClient. The RETURN leg
     * was already complete — AuthCallbackActivity is a manifest App Link and
     * finishes the PKCE exchange — so this is the missing half, not a new
     * flow.
     */
    suspend fun startOAuth(context: android.content.Context, provider: OAuthSignIn.Provider) {
        // Through [run], like every other action here, and NOT a bare call.
        //
        // [AuthViewModel.signInWithProvider] says failures surface through the
        // lastError collector, and without this they could not: it calls this
        // from a bare `viewModelScope.launch`, so anything thrown here reached
        // the coroutine's uncaught handler and took the process down. The
        // throw is not hypothetical - `CustomTabsIntent.launchUrl` calls
        // `startActivity`, which raises ActivityNotFoundException on a device
        // with no browser, and `require(isAvailable(provider))` raises
        // IllegalArgumentException for a disabled provider.
        run { OAuthSignIn.launch(context, client, provider) }
    }

    suspend fun signIn(email: String, password: String, captchaToken: String? = null) {
        run {
            client.auth.signInWith(Email) {
                this.email = email
                this.password = password
                captchaToken?.let { this.captchaToken = it }
            }
        }
    }

    suspend fun signUp(
        email: String,
        password: String,
        fullName: String?,
        captchaToken: String? = null,
    ) {
        run {
            client.auth.signUpWith(Email) {
                this.email = email
                this.password = password
                captchaToken?.let { this.captchaToken = it }
                fullName?.takeIf { it.isNotBlank() }?.let { name ->
                    data = buildJsonObject { put("full_name", name) }
                }
            }
        }
    }

    /** US-810: re-send the signup confirmation for an unconfirmed account. */
    suspend fun resendConfirmation(email: String) {
        run {
            client.auth.resendEmail(io.github.jan.supabase.auth.OtpType.Email.SIGNUP, email)
        }
    }

    suspend fun resetPassword(email: String) {
        run { client.auth.resetPasswordForEmail(email) }
    }

    /**
     * US-1499 LOCAL-FIRST sign-out: local teardown + phase change + telemetry
     * clear happen regardless of network; the server revoke is best-effort.
     */
    suspend fun signOut() {
        // 1) Signal the local-data wipe FIRST (watermark reset before row
        //    wipe is the consumer's contract — US-1323).
        signOutFlow.tryEmit(Unit)
        WorkspaceScope.clear()
        Telemetry.clearUser()
        lastUser = null
        errorFlow.value = null
        // 2) Leave the signed-in UI immediately.
        phaseFlow.value = Phase.SignedOut
        // 3) Best-effort server revoke + local session clear; offline failure
        //    is non-fatal — we're already locally signed out.
        runCatching { client.auth.signOut() }
    }

    fun clearError() {
        errorFlow.value = null
    }

    val currentUser: UserInfo?
        get() = client.auth.currentUserOrNull()

    private suspend fun run(block: suspend () -> Unit) {
        errorFlow.value = null
        try {
            block()
        } catch (t: Throwable) {
            errorFlow.value = FriendlyAuthError.classify(t)
        }
    }
}
