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
    private val pushRegistration: com.gradethread.app.platform.push.PushRegistration,
    private val backgroundRefresh: com.gradethread.app.sync.BackgroundRefreshStore,
    private val onboarding: com.gradethread.app.onboarding.OnboardingStore,
    private val realtime: com.gradethread.app.sync.RealtimeService,
    /** US-2412: the data-access export. */
    private val accountExport: AccountExportService,
    /** US-2496: signed URLs for the outgoing account's private photos. */
    private val photoUrls: com.gradethread.app.upload.PhotoSignedUrlProvider,
    /** US-2496: the outgoing account's verified-seller profile, on disk. */
    private val verifiedCache: com.gradethread.app.verified.VerifiedCache,
    /** US-2776: the erasure right, which Play requires in-app. */
    private val accountDeletion: AccountDeletionService,
) : ViewModel() {

    data class State(
        val email: String? = null,
        val profile: AccountProfile? = null,
        val loadingProfile: Boolean = false,
        val showCostOnRows: Boolean = false,
        val confirmBulkActions: Boolean = true,
        val hapticsEnabled: Boolean = true,
        val analyticsEnabled: Boolean = false,
        val backgroundRefreshEnabled: Boolean = true,
        /** Non-null while a destructive action is awaiting confirmation. */
        val pendingConfirm: Confirm? = null,
        val busy: Boolean = false,
        val notice: String? = null,
        /** US-2412: true while the export is being built. */
        val exporting: Boolean = false,
        /**
         * The staged export, ready for the share sheet. Consumed once — see
         * [exportShared] — so a recomposition cannot open the sheet twice.
         */
        val exportFile: java.io.File? = null,
        val exportError: String? = null,
        /**
         * US-2776: the deletion dialog's own state.
         *
         * Kept here rather than in the Composable because a deletion that is
         * mid-flight must survive a rotation. Local `remember` state would reset
         * the typed phrase and re-enable the button while the request is still
         * running, which is the one screen where a double submit matters.
         */
        val deleteConfirmText: String = "",
        val deletePassword: String = "",
        /** Set once the SERVER has asked for a password. Never guessed. */
        val deletePasswordRequired: Boolean = false,
        val deleting: Boolean = false,
        val deleteError: String? = null,
    ) {
        /** The delete button is live only on an exact match. */
        val deleteConfirmed: Boolean
            get() = deleteConfirmText.trim() == AccountDeletionService.CONFIRM_PHRASE
    }

    enum class Confirm { SIGN_OUT, DELETE_ACCOUNT }

    /**
     * US-2412: build the account export.
     *
     * No user id is sent. The server reads the subject from the bearer token,
     * which is the only shape a data-access endpoint can safely have.
     */
    fun exportAccount() {
        if (_state.value.exporting) return
        _state.value = _state.value.copy(exporting = true, exportError = null)
        viewModelScope.launch {
            runCatching { accountExport.export() }
                .onSuccess { _state.value = _state.value.copy(exportFile = it) }
                .onFailure {
                    _state.value = _state.value.copy(
                        exportError = AccountExportService.message(it),
                    )
                }
            _state.value = _state.value.copy(exporting = false)
        }
    }

    /** The sheet has been opened; drop the file so it is offered only once. */
    fun exportShared() {
        _state.value = _state.value.copy(exportFile = null)
    }

    fun dismissExportError() {
        _state.value = _state.value.copy(exportError = null)
    }

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
        viewModelScope.launch {
            backgroundRefresh.enabled.collect { value ->
                update { it.copy(backgroundRefreshEnabled = value) }
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

    /**
     * US-1379: the background refresh toggle.
     *
     * The stored flag AND the WorkManager schedule move together. Storing the
     * flag alone would leave the periodic work running and merely silent, which
     * still spends the seller's battery and data on a switch they turned off.
     */
    fun setBackgroundRefreshEnabled(enabled: Boolean) {
        viewModelScope.launch {
            backgroundRefresh.setEnabled(enabled)
            com.gradethread.app.sync.BackgroundRefreshWorker.apply(context, enabled)
        }
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
            val wiped = tearDownSession()
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
     * US-2776: everything sign-out and deletion both have to do to this device,
     * in one place.
     *
     * It was inlined in [confirmSignOut] and deletion did not exist, so there was
     * nothing to share. Now there is, and a copy would be the wrong shape of
     * mistake: the teardown is nine steps whose ORDER matters (socket before
     * rows, push token before the session that authenticates its removal), and a
     * second hand-maintained copy is how one of them ends up missing a step that
     * leaves the deleted account's garment photos on a phone.
     *
     * Returns whether the local wipe fully succeeded. It never throws: a failed
     * wipe must not strand someone signed into an account that no longer exists.
     * The caller signs out either way and says so if bytes were left behind.
     */
    private suspend fun tearDownSession(): Boolean {
        val wiped = runCatching {
            sessionScope.signOutWipe(
                SessionScope.Hooks(
                    // US-2367: the socket goes FIRST. It is authenticated
                    // with the session being thrown away, and an event
                    // arriving mid-wipe would write the outgoing account's
                    // rows back into a database we are emptying.
                    stopRealtime = { runCatching { realtime.pause() } },
                    // Upload teardown belongs to its own story;
                    // the row + watermark wipe is what AC2 requires and what
                    // leaks tenant data without it.
                    //
                    // US-2496: these three are RETENTION, not correctness.
                    // Correctness is the owner-scoped cache key in EdgeApi,
                    // which is self-healing - a different owner is a
                    // different key, so the next account can never be SERVED
                    // the previous one's answer whether or not anyone
                    // remembers to add a clearance here. What these drop is
                    // the outgoing account's BYTES: edge response bodies
                    // (up to an hour), signed URLs for their private grading
                    // photos (capability tokens, live until their TTL), and
                    // their verified-seller profile (on disk, indefinitely).
                    // On a shared phone that is one seller's data sitting in
                    // another seller's process. Two separate jobs; do not
                    // delete either thinking it duplicates the other.
                    clearances = listOf<suspend () -> Unit>(
                        { com.gradethread.app.platform.net.EdgeApi.clearAllResponseCaches() },
                        photoUrls.signOutClearance(),
                        { runCatching { verifiedCache.clear() } },
                    ),
                ),
            )
        }.isSuccess
        // US-1378: the push token goes BEFORE the session does, because
        // unregistering needs the session's own token to authenticate. Left
        // behind, the server would keep pushing this account's sales to a
        // phone somebody else may now be holding.
        runCatching { pushRegistration.clear() }
        // US-1379: the next account must start with NO baseline. Left in
        // place, their first refresh would compare their rows against the
        // previous seller's and announce the whole catalogue as new.
        runCatching { backgroundRefresh.clear() }
        // US-1384: the next account gets its own first run, and its own
        // use-case answer. Reusing the previous seller's would route a
        // brand-new user into a flow they never chose.
        runCatching { onboarding.clear() }
        // US-1382: staged share photos are someone's garments, in their
        // house. The next account on this device must not inherit them.
        runCatching {
            com.gradethread.app.intake.IntakeInboxStore.clearAll(context, db)
        }
        // US-1380: the widget sits on a home screen anyone can see, so the
        // previous seller's takings come off it now, not at the next sync.
        runCatching {
            com.gradethread.app.widget.WidgetPublisher.publishSignedOut(
                context,
                System.currentTimeMillis(),
            )
        }
        WorkspaceScope.clear()
        return wiped
    }

    // ── US-2776: account deletion ────────────────────────────────────────────
    //
    // This used to be a dialog that said "email support@gradethread.com". The
    // reasoning written against it was sound as far as it went — a client that
    // only cleared the `users` row would leave a paying subscription running —
    // but the conclusion was wrong, because it treated "the client cannot cascade"
    // as "the client cannot delete". The cascade lives on the server and the web
    // app has called it since US-194; there was an endpoint to call the whole
    // time. Google Play's User Data policy names an email-support instruction as
    // exactly what does not satisfy the in-app deletion requirement, so the
    // honest-looking dead end was also the thing blocking the store listing.

    /** Typing in the confirmation field. */
    fun deleteConfirmTextChanged(value: String) {
        update { it.copy(deleteConfirmText = value, deleteError = null) }
    }

    /** Typing in the password field, which only appears once the server asks. */
    fun deletePasswordChanged(value: String) {
        update { it.copy(deletePassword = value, deleteError = null) }
    }

    /** Close the dialog and forget everything typed into it. */
    fun cancelDelete() {
        update {
            it.copy(
                pendingConfirm = null,
                deleteConfirmText = "",
                deletePassword = "",
                deletePasswordRequired = false,
                deleteError = null,
            )
        }
    }

    /**
     * Delete the account, then this device's copy of it.
     *
     * Order is deliberate and is the opposite of sign-out's. Sign-out wipes
     * first, because the account still exists and the risk is the next person
     * seeing it. Here the server call goes first, because it is the step that can
     * fail: wiping a device and then failing to delete would leave a live account
     * with a paying subscription and no local data to reach it with.
     */
    fun confirmDeleteAccount() {
        val current = _state.value
        if (current.deleting || !current.deleteConfirmed) return
        update { it.copy(deleting = true, deleteError = null) }
        viewModelScope.launch {
            val password = _state.value.deletePassword.takeIf { it.isNotEmpty() }
            when (val outcome = accountDeletion.delete(password)) {
                AccountDeletionService.Outcome.Deleted -> {
                    // The account is gone server-side, so the local wipe is no
                    // longer optional politeness — every row and photo left here
                    // belongs to an account that cannot be signed into again.
                    val wiped = tearDownSession()
                    auth.signOut()
                    update {
                        it.copy(
                            pendingConfirm = null,
                            deleting = false,
                            deleteConfirmText = "",
                            deletePassword = "",
                            deletePasswordRequired = false,
                            notice = if (wiped) {
                                "Your account has been permanently deleted."
                            } else {
                                "Your account has been permanently deleted, but some " +
                                    "cached data couldn't be cleared from this device."
                            },
                        )
                    }
                }

                AccountDeletionService.Outcome.PasswordRequired -> update {
                    it.copy(
                        deleting = false,
                        deletePasswordRequired = true,
                        deleteError = "Enter your password to confirm deleting your account.",
                    )
                }

                is AccountDeletionService.Outcome.Failed -> update {
                    it.copy(deleting = false, deleteError = outcome.message)
                }
            }
        }
    }
}
