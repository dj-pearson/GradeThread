package com.gradethread.app.settings

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.auth.AuthRepository
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.platform.workspace.WorkspaceScope
import com.gradethread.app.sync.SessionScope
import com.gradethread.app.sync.SyncWatermark
import com.gradethread.app.sync.db.GradeThreadDb
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.postgrest.from
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import javax.inject.Inject

/** The account row the plan section renders. */
@Serializable
data class AccountProfile(
    val id: String = "",
    val email: String = "",
    @SerialName("full_name") val fullName: String? = null,
    val plan: String = "free",
    @SerialName("grade_credit_balance") val creditBalance: Int = 0,
    @SerialName("grades_used_this_month") val gradesUsedThisMonth: Int = 0,
)

/**
 * US-1383: the settings screen.
 *
 * Two things here are load-bearing beyond the UI:
 *
 *  1. SIGN-OUT WIPES THE LOCAL CACHE. [SessionScope.signOutWipe] existed with the
 *     correct crash-safe ordering (watermarks reset BEFORE rows) but had no
 *     production caller, so signing out on Android left the previous account's
 *     entire inventory, sales and pending mutations in Room. Signing in as a
 *     different account then showed the old account's data until a pull happened
 *     to overwrite it — and rows the new account doesn't have would never be
 *     reconciled away at all. AC2 requires the wipe; this is where it happens.
 *  2. The wipe runs BEFORE [AuthRepository.signOut] flips the phase, so the
 *     signed-in UI is never on screen with a half-emptied database under it.
 */
@HiltViewModel
class SettingsViewModel @Inject constructor(
    @ApplicationContext private val context: Context,
    private val auth: AuthRepository,
    private val client: SupabaseClient,
    private val db: GradeThreadDb,
) : ViewModel() {

    data class State(
        val email: String? = null,
        val profile: AccountProfile? = null,
        val loadingProfile: Boolean = false,
        val showCostOnRows: Boolean = false,
        val confirmBulkActions: Boolean = true,
        val hapticsEnabled: Boolean = true,
        val analyticsEnabled: Boolean = false,
        /** Non-null while a destructive action is awaiting confirmation. */
        val pendingConfirm: Confirm? = null,
        val busy: Boolean = false,
        val notice: String? = null,
    )

    enum class Confirm { SIGN_OUT, DELETE_ACCOUNT }

    private val preferences = AppPreferences(context)
    private val sessionScope = SessionScope(db, SyncWatermark(context))

    /**
     * ONE mutable state rather than ten flows combined.
     *
     * The screen has around a dozen independent inputs — three persisted
     * preferences, the telemetry opt-out, the auth phase, the plan row, and four
     * transient UI bits. `combine` caps at five, and nesting it to fit forces
     * positional index access (`flags[0]`) that silently reorders under a later
     * edit. Collectors writing into a single [State] keeps every field named.
     */
    private val _state = MutableStateFlow(
        State(analyticsEnabled = Telemetry.isAnalyticsEnabled()),
    )
    val state: StateFlow<State> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            auth.phase.collect { phase ->
                update {
                    it.copy(email = (phase as? AuthRepository.Phase.SignedIn)?.email)
                }
            }
        }
        viewModelScope.launch {
            preferences.showCostOnRows.collect { value ->
                update { it.copy(showCostOnRows = value) }
            }
        }
        viewModelScope.launch {
            preferences.confirmBulkActions.collect { value ->
                update { it.copy(confirmBulkActions = value) }
            }
        }
        viewModelScope.launch {
            preferences.hapticsEnabled.collect { value ->
                update { it.copy(hapticsEnabled = value) }
            }
        }
    }

    private fun update(transform: (State) -> State) {
        _state.value = transform(_state.value)
    }

    /**
     * Load the plan row.
     *
     * Scoped to the SIGNED-IN USER, not the active workspace: a plan belongs to
     * the person paying for it, and reading it under a workspace owner's id
     * would show a member their host's plan and credits.
     */
    fun loadProfile() {
        val userId = client.auth.currentUserOrNull()?.id ?: return
        if (_state.value.loadingProfile) return
        update { it.copy(loadingProfile = true) }
        viewModelScope.launch {
            val loaded = runCatching {
                client.from("users").select {
                    filter { eq("id", userId) }
                    limit(1)
                }.decodeList<AccountProfile>().firstOrNull()
            }
                // Silent on failure: the rest of settings works offline, and an
                // error banner over the whole screen because one row didn't load
                // would be disproportionate. The section shows its own
                // "unavailable" copy instead.
                .getOrNull()
            update { it.copy(profile = loaded, loadingProfile = false) }
        }
    }

    fun setShowCostOnRows(enabled: Boolean) {
        viewModelScope.launch { preferences.setShowCostOnRows(enabled) }
    }

    fun setConfirmBulkActions(enabled: Boolean) {
        viewModelScope.launch { preferences.setConfirmBulkActions(enabled) }
    }

    fun setHapticsEnabled(enabled: Boolean) {
        viewModelScope.launch { preferences.setHapticsEnabled(enabled) }
    }

    fun setAnalyticsEnabled(enabled: Boolean) {
        viewModelScope.launch {
            Telemetry.setAnalyticsEnabled(context, enabled)
            // Read BACK from Telemetry rather than trusting the requested value:
            // opting in only takes effect if PostHog actually starts (it needs a
            // configured API key), and a toggle that flips on regardless would
            // claim consent we never acted on.
            update { it.copy(analyticsEnabled = Telemetry.isAnalyticsEnabled()) }
        }
    }

    fun ask(confirm: Confirm) {
        update { it.copy(pendingConfirm = confirm) }
    }

    fun cancelConfirm() {
        update { it.copy(pendingConfirm = null) }
    }

    fun dismissNotice() {
        update { it.copy(notice = null) }
    }

    /** Email a password-reset link — the flow that already exists for sign-in. */
    fun changePassword() {
        val email = (auth.phase.value as? AuthRepository.Phase.SignedIn)?.email
        if (email.isNullOrBlank()) {
            update { it.copy(notice = "We don't have an email address for this account.") }
            return
        }
        viewModelScope.launch {
            update { it.copy(busy = true) }
            val message = runCatching { auth.resetPassword(email) }.fold(
                onSuccess = { "Check $email for a link to set a new password." },
                onFailure = { it.message ?: "Couldn't send that link." },
            )
            update { it.copy(busy = false, notice = message) }
        }
    }

    /**
     * Sign out, wiping local data first.
     *
     * The wipe is NOT best-effort-after: it runs to completion before the phase
     * flips, because the failure mode of doing it the other way round is the next
     * user seeing the previous one's inventory. If the wipe itself throws we
     * still sign out — stranding someone signed-in on a broken cache would be
     * worse — but we say so, because their data is still on the device.
     */
    fun confirmSignOut() {
        update { it.copy(pendingConfirm = null, busy = true) }
        viewModelScope.launch {
            val wiped = runCatching {
                sessionScope.signOutWipe(
                    SessionScope.Hooks(
                        // Realtime/upload teardown belong to their own stories;
                        // the row + watermark wipe is what AC2 requires and what
                        // leaks tenant data without it.
                        clearances = emptyList(),
                    ),
                )
            }.isSuccess
            WorkspaceScope.clear()
            auth.signOut()
            update {
                it.copy(
                    busy = false,
                    notice = if (wiped) {
                        null
                    } else {
                        // Said out loud: their data is still on this device.
                        "Signed out, but some cached data couldn't be cleared from this device."
                    },
                )
            }
        }
    }

    /**
     * Account deletion.
     *
     * Deliberately NOT implemented client-side. Deleting an account has to cascade
     * server-side (storage objects, Stripe subscription, eBay tokens), and a
     * client that only cleared the `users` row would leave a paying subscription
     * running against an account the seller believes is gone. The honest state is
     * to point at the flow that can actually do it rather than ship a button that
     * half-works. Tracked with the account-export/delete story.
     */
    fun confirmDeleteAccount() {
        update {
            it.copy(
                pendingConfirm = null,
                notice = "To delete your account and data, email support@gradethread.com — " +
                    "we'll confirm and remove everything within 30 days.",
            )
        }
    }
}
