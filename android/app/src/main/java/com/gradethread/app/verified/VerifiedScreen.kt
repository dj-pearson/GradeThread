package com.gradethread.app.verified

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.R
import com.gradethread.app.marketplaces.CustomTabsLauncher
import com.gradethread.app.platform.net.EdgeApiError
import com.gradethread.app.platform.telemetry.Telemetry
import com.gradethread.app.ui.components.InfoCard
import com.gradethread.app.ui.components.InfoTone
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1375: where the seller stands on the verified badge.
 */
@HiltViewModel
class VerifiedViewModel @Inject constructor(private val service: VerifiedProviding) : ViewModel() {

    data class State(
        val profile: VerifiedProfile? = null,
        val stats: VerifiedStats = VerifiedStats(),
        val loading: Boolean = false,
        val loaded: Boolean = false,
        /** True when what's on screen came from disk, not from the server. */
        val stale: Boolean = false,
        val errorMessage: String? = null,
        /** US-2493: a write is in flight. */
        val saving: Boolean = false,
        /** US-2493: the open editor, or null when nothing is being edited. */
        val editor: Editor? = null,
    ) {
        val status: VerifiedStatus? get() = profile?.let { VerifiedBadge.status(it) }

        val requirements: List<VerifiedRequirement>
            get() = profile?.let { VerifiedBadge.requirements(it, stats) }.orEmpty()

        val progress: Float get() = VerifiedBadge.progress(requirements)

        val nextStep: VerifiedRequirement? get() = VerifiedBadge.nextStep(requirements)

        val profileUrl: String? get() = profile?.let { VerifiedBadge.profileUrl(it) }

        val credentials: String? get() = VerifiedBadge.credentials(stats)

        val sinceLabel: String? get() = profile?.let { VerifiedBadge.sinceLabel(it) }
    }

    /**
     * US-2493: the in-progress edit, held apart from the loaded profile.
     *
     * Separate so a failed save leaves what the seller typed intact while the
     * profile on screen stays whatever the server last confirmed. Merging the
     * two is how a rejected handle ends up displayed as though it were claimed.
     */
    data class Editor(
        val handle: String = "",
        val displayName: String = "",
        val bio: String = "",
        val checkingHandle: Boolean = false,
        /** Null = not asked yet. */
        val handleAvailable: Boolean? = null,
        /** Why the SHAPE is wrong, as a resource id. */
        val handleError: Int? = null,
        /** Why the server refused it — the one reason only it knows. */
        val handleTakenReason: String? = null,
        val saving: Boolean = false,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    fun load() {
        if (_state.value.loading) return
        _state.value = _state.value.copy(loading = true, errorMessage = null)
        Telemetry.screen("verified")

        viewModelScope.launch {
            // The cached copy goes up FIRST, so an offline open shows the last
            // known standing immediately rather than a spinner that resolves
            // into an error.
            if (_state.value.profile == null) {
                service.cached()?.let { cached ->
                    _state.value = _state.value.copy(
                        profile = cached.profile,
                        stats = cached.stats,
                        loaded = true,
                        stale = true,
                    )
                }
            }

            runCatching { service.profile() }.fold(
                onSuccess = { response ->
                    _state.value = State(
                        profile = response.profile,
                        stats = response.stats,
                        loaded = true,
                        stale = false,
                    )
                },
                onFailure = { error ->
                    _state.value = _state.value.copy(
                        loading = false,
                        errorMessage = if (_state.value.profile != null) {
                            // There IS something on screen; say it might be old
                            // rather than shouting about a failure.
                            "Showing what we last knew. Couldn't reach the server just now."
                        } else {
                            (error as? EdgeApiError)?.userMessage()
                                ?: "Couldn't load your verification status."
                        },
                    )
                },
            )
        }
    }

    fun dismissError() {
        _state.value = _state.value.copy(errorMessage = null)
    }

    // ── US-2493: the write half ──────────────────────────────────────────────

    /** Open the editor seeded from what is on screen. */
    fun startEditing() {
        val profile = _state.value.profile ?: return
        _state.value = _state.value.copy(
            editor = Editor(
                handle = profile.handle.orEmpty(),
                displayName = profile.displayName.orEmpty(),
                bio = profile.bio.orEmpty(),
            ),
        )
    }

    fun cancelEditing() {
        _state.value = _state.value.copy(editor = null)
    }

    fun editHandle(value: String) = editEditor {
        // Any edit invalidates the previous answer. Leaving the old one up
        // would let a seller read "available" about a handle they have since
        // changed, which is worse than reading nothing.
        it.copy(handle = value, handleError = null, handleAvailable = null)
    }

    fun editDisplayName(value: String) = editEditor { it.copy(displayName = value) }

    fun editBio(value: String) = editEditor { it.copy(bio = value) }

    /**
     * AC2: ask the server whether the handle is free BEFORE saving.
     *
     * The shape is checked locally first so an obviously-invalid handle costs
     * no round trip and gets a reason naming the actual rule it broke.
     */
    fun checkHandle() {
        val editor = _state.value.editor ?: return
        val shapeError = VerifiedHandleRules.shapeError(editor.handle)
        if (shapeError != null) {
            editEditor { it.copy(handleError = shapeError, handleAvailable = null) }
            return
        }
        editEditor { it.copy(checkingHandle = true) }
        viewModelScope.launch {
            runCatching { service.handleAvailable(editor.handle) }.fold(
                onSuccess = { answer ->
                    editEditor {
                        it.copy(
                            checkingHandle = false,
                            handleAvailable = answer.available,
                            // "Already taken" is the one reason only the server
                            // knows, so it is the one that arrives as English
                            // from the server rather than as a resource.
                            handleTakenReason = answer.reason.takeIf { _ -> !answer.available },
                        )
                    }
                },
                onFailure = {
                    editEditor {
                        it.copy(checkingHandle = false, handleAvailable = null)
                    }
                },
            )
        }
    }

    /**
     * Save the fields the seller actually changed.
     *
     * Only differences are sent. A save that re-sent every field would rewrite
     * a bio the seller never opened, and on a handle it would trip the server's
     * uniqueness check against the seller's own existing handle.
     */
    fun saveProfile() {
        val state = _state.value
        val editor = state.editor ?: return
        val current = state.profile ?: return
        if (editor.saving) return

        val handle = VerifiedHandleRules.normalize(editor.handle)
        val handleChanged = handle.isNotEmpty() && handle != current.handle.orEmpty()
        if (handleChanged) {
            val shapeError = VerifiedHandleRules.shapeError(handle)
            if (shapeError != null) {
                editEditor { it.copy(handleError = shapeError) }
                return
            }
            if (editor.handleAvailable == false) return // AC2: refused before the save
        }

        val update = VerifiedProfileUpdate(
            handle = handle.takeIf { handleChanged },
            displayName = editor.displayName.trim()
                .takeIf { it != current.displayName.orEmpty() },
            bio = editor.bio.trim().takeIf { it != current.bio.orEmpty() },
        )
        if (update == VerifiedProfileUpdate()) {
            _state.value = state.copy(editor = null)
            return
        }

        editEditor { it.copy(saving = true) }
        applyUpdate(update) { _state.value = _state.value.copy(editor = null) }
    }

    /** Flip one of the three switches. Sent on its own, nothing else touched. */
    fun setEnabled(value: Boolean) = applyUpdate(VerifiedProfileUpdate(enabled = value))

    fun setShowListings(value: Boolean) = applyUpdate(VerifiedProfileUpdate(showListings = value))

    fun setEmbedInListings(value: Boolean) = applyUpdate(VerifiedProfileUpdate(embedInListings = value))

    private fun applyUpdate(update: VerifiedProfileUpdate, onSuccess: () -> Unit = {}) {
        if (_state.value.saving) return
        _state.value = _state.value.copy(saving = true, errorMessage = null)
        viewModelScope.launch {
            runCatching { service.update(update) }.fold(
                onSuccess = { response ->
                    _state.value = _state.value.copy(
                        profile = response.profile,
                        stats = response.stats,
                        loaded = true,
                        stale = false,
                        saving = false,
                    )
                    onSuccess()
                },
                onFailure = { error ->
                    // The switch snaps back, because the state on screen came
                    // from the server and the server did not change. A toggle
                    // that stayed flipped would claim a profile is public when
                    // it is not.
                    _state.value = _state.value.copy(
                        saving = false,
                        editor = _state.value.editor?.copy(saving = false),
                        errorMessage = (error as? EdgeApiError)?.userMessage()
                            ?: "Couldn't save that. Try again.",
                    )
                },
            )
        }
    }

    private inline fun editEditor(block: (Editor) -> Editor) {
        val editor = _state.value.editor ?: return
        _state.value = _state.value.copy(editor = block(editor))
    }
}

@Composable
fun VerifiedScreen(onClose: () -> Unit = {}, viewModel: VerifiedViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()
    val context = androidx.compose.ui.platform.LocalContext.current
    LaunchedEffect(Unit) { viewModel.load() }

    VerifiedContent(
        state,
        VerifiedActions(
            retry = viewModel::load,
            startEditing = viewModel::startEditing,
            editHandle = viewModel::editHandle,
            checkHandle = viewModel::checkHandle,
            editDisplayName = viewModel::editDisplayName,
            editBio = viewModel::editBio,
            saveProfile = viewModel::saveProfile,
            cancelEditing = viewModel::cancelEditing,
            setEnabled = viewModel::setEnabled,
            setShowListings = viewModel::setShowListings,
            setEmbedInListings = viewModel::setEmbedInListings,
            // A Custom Tab needs a real Context, which a golden has nowhere to
            // get.
            openPublicProfile = { url -> CustomTabsLauncher.open(context, url) },
            close = onClose,
        ),
    )
}

/** Everything this screen can be asked to do (US-2902 AC3). */
@Suppress("LongParameterList")
@Immutable
data class VerifiedActions(
    val retry: () -> Unit = {},
    val startEditing: () -> Unit = {},
    val editHandle: (String) -> Unit = {},
    val checkHandle: () -> Unit = {},
    val editDisplayName: (String) -> Unit = {},
    val editBio: (String) -> Unit = {},
    val saveProfile: () -> Unit = {},
    val cancelEditing: () -> Unit = {},
    val setEnabled: (Boolean) -> Unit = {},
    val setShowListings: (Boolean) -> Unit = {},
    val setEmbedInListings: (Boolean) -> Unit = {},
    val openPublicProfile: (String) -> Unit = {},
    val close: () -> Unit = {},
)

/**
 * The public seller profile, with no ViewModel attached (US-2902 AC3).
 *
 * ⚠ A HANDLE IS PUBLIC AND PERMANENT-ISH, so the editor has three answers about
 * one: not checked yet, available, and taken. `handleAvailable` is a nullable
 * Boolean precisely because "we have not asked" is not "no", and a form that
 * rendered null as taken would refuse a name nobody has.
 *
 * ⚠ AND `stale` IS NOT AN ERROR. It means the numbers on screen came from the
 * device rather than the server. The card says so instead of blanking, because
 * a seller looking at their own badge progress would rather see yesterday's
 * figure than nothing.
 */
@Composable
fun VerifiedContent(state: VerifiedViewModel.State, actions: VerifiedActions, modifier: Modifier = Modifier) {
    Column(
        modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Text(stringResource(R.string.verified_title), style = MaterialTheme.typography.titleLarge)
        Text(
            // Says up front where changes are made, so a read-only screen isn't
            // mistaken for a broken one.
            stringResource(R.string.verified_subtitle),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        state.errorMessage?.let {
            InfoCard(
                if (state.profile != null) {
                    stringResource(R.string.verified_maybe_stale)
                } else {
                    stringResource(R.string.common_that_didnt_work)
                },
                it,
                tone = if (state.profile != null) InfoTone.Warning else InfoTone.Error,
            )
        }

        val status = state.status
        if (status != null) {
            Column(
                Modifier.fillMaxWidth().cardStyle(),
                verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
            ) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        status.label,
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.weight(1f),
                    )
                    if (state.stale) {
                        Text(
                            stringResource(R.string.common_offline),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                Text(status.detail, style = MaterialTheme.typography.bodyMedium)
                state.sinceLabel?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                state.credentials?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                    )
                }
                LinearProgressIndicator(
                    progress = { state.progress },
                    modifier = Modifier.fillMaxWidth(),
                )
                state.nextStep?.let {
                    // One step, not four. A list of everything undone is a wall;
                    // the first thing is the only one that matters today.
                    Text(
                        stringResource(R.string.verified_next_step, it.title.lowercase()),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
            }
        } else if (state.loading) {
            Text(
                stringResource(R.string.common_loading),
                style = MaterialTheme.typography.bodyMedium,
            )
        }

        // US-2493: the write half. Until this shipped, an Android seller could
        // read all four steps of the checklist and do none of them.
        if (state.profile != null) {
            val editor = state.editor
            if (editor == null) {
                BrandSecondaryButton(
                    text = stringResource(R.string.verified_edit_profile),
                    modifier = Modifier.fillMaxWidth(),
                ) { actions.startEditing() }
            } else {
                VerifiedEditor(
                    editor = editor,
                    onHandle = actions.editHandle,
                    onCheckHandle = actions.checkHandle,
                    onDisplayName = actions.editDisplayName,
                    onBio = actions.editBio,
                    onSave = actions.saveProfile,
                    onCancel = actions.cancelEditing,
                )
            }

            VisibilitySwitches(state, actions)
        }

        if (state.requirements.isNotEmpty()) {
            Text(
                stringResource(R.string.verified_requirements_title),
                style = MaterialTheme.typography.titleMedium,
            )
            state.requirements.forEach { requirement ->
                Column(
                    Modifier.fillMaxWidth().cardStyle(),
                    verticalArrangement = Arrangement.spacedBy(Spacing.xxs),
                ) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            requirement.title,
                            style = MaterialTheme.typography.bodyLarge,
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            if (requirement.met) {
                                stringResource(R.string.common_done_state)
                            } else {
                                stringResource(R.string.common_todo_state)
                            },
                            style = MaterialTheme.typography.labelMedium,
                            color = if (requirement.met) {
                                MaterialTheme.colorScheme.primary
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            },
                        )
                    }
                    Text(
                        requirement.detail,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        state.profileUrl?.let { url ->
            BrandSecondaryButton(
                text = stringResource(R.string.verified_view_profile),
                modifier = Modifier.fillMaxWidth(),
            ) {
                actions.openPublicProfile(url)
            }
        }
        BrandSecondaryButton(
            text = if (state.loading) {
                stringResource(R.string.verified_checking)
            } else {
                stringResource(R.string.common_refresh)
            },
            enabled = !state.loading,
            modifier = Modifier.fillMaxWidth(),
        ) { actions.retry() }
        BrandSecondaryButton(
            text = stringResource(R.string.common_back),
            modifier = Modifier.fillMaxWidth(),
        ) { actions.close() }
    }
}

/**
 * US-2493: claim or change a handle, and set the name and bio buyers read.
 *
 * The handle field carries its own verdict line, and it is the only field that
 * does: it is the only one that can be refused for a reason the seller cannot
 * see by looking at what they typed.
 */
/**
 * The three switches that decide what the world can see.
 *
 * Split out because inlined they took VerifiedContent to a cyclomatic
 * complexity of exactly 20, the configured ceiling. They belong together: each
 * one widens what a stranger can read about this seller.
 *
 * ⚠ THE FIRST ONE IS DISABLED WITHOUT A HANDLE, and says why. The server
 * refuses to publish a profile with no handle, so offering the tap would be a
 * switch whose only outcome is a 400.
 */
@Composable
private fun VisibilitySwitches(state: VerifiedViewModel.State, actions: VerifiedActions) {
    // Same spacing as the parent column, so wrapping these three for the
    // one-emitter rule does not move a pixel.
    Column(verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
        VerifiedSwitchRow(
            label = stringResource(R.string.verified_public_profile),
            detail = if (state.profile?.handle.isNullOrBlank()) {
                stringResource(R.string.verified_public_needs_handle)
            } else {
                stringResource(R.string.verified_public_detail)
            },
            checked = state.profile?.enabled == true,
            enabled = !state.saving && !state.profile?.handle.isNullOrBlank(),
            onCheckedChange = actions.setEnabled,
        )
        VerifiedSwitchRow(
            label = stringResource(R.string.verified_show_listings),
            detail = stringResource(R.string.verified_show_listings_detail),
            checked = state.profile?.showListings == true,
            enabled = !state.saving,
            onCheckedChange = actions.setShowListings,
        )
        VerifiedSwitchRow(
            label = stringResource(R.string.verified_embed_in_listings),
            detail = stringResource(R.string.verified_embed_in_listings_detail),
            checked = state.profile?.embedInListings == true,
            enabled = !state.saving,
            onCheckedChange = actions.setEmbedInListings,
        )
    }
}

@Composable
private fun VerifiedEditor(
    editor: VerifiedViewModel.Editor,
    onHandle: (String) -> Unit,
    onCheckHandle: () -> Unit,
    onDisplayName: (String) -> Unit,
    onBio: (String) -> Unit,
    onSave: () -> Unit,
    onCancel: () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().cardStyle(),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        OutlinedTextField(
            value = editor.handle,
            onValueChange = onHandle,
            label = { Text(stringResource(R.string.verified_handle_label)) },
            singleLine = true,
            // Once there is something typed, show the address they would
            // actually get. The placeholder version is only useful while the
            // field is empty.
            supportingText = {
                val typed = VerifiedHandleRules.normalize(editor.handle)
                Text(
                    if (typed.isEmpty()) {
                        stringResource(R.string.verified_handle_help)
                    } else {
                        stringResource(R.string.verified_handle_help_typed, typed)
                    },
                )
            },
            isError = editor.handleError != null || editor.handleAvailable == false,
            modifier = Modifier.fillMaxWidth(),
        )
        // One line, three possible states, and never two at once: the shape is
        // wrong, the server says taken, or it is free.
        when {
            editor.handleError != null -> Text(
                stringResource(editor.handleError),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
            editor.handleAvailable == false -> Text(
                editor.handleTakenReason ?: stringResource(R.string.verified_handle_taken),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
            editor.handleAvailable == true -> Text(
                stringResource(R.string.verified_handle_free),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.primary,
            )
        }
        BrandSecondaryButton(
            text = if (editor.checkingHandle) {
                stringResource(R.string.verified_handle_checking)
            } else {
                stringResource(R.string.verified_handle_check)
            },
            enabled = !editor.checkingHandle && editor.handle.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) { onCheckHandle() }

        OutlinedTextField(
            value = editor.displayName,
            onValueChange = onDisplayName,
            label = { Text(stringResource(R.string.verified_display_name_label)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = editor.bio,
            onValueChange = onBio,
            label = { Text(stringResource(R.string.verified_bio_label)) },
            supportingText = {
                Text(stringResource(R.string.verified_bio_help, editor.bio.length, MAX_BIO))
            },
            isError = editor.bio.length > MAX_BIO,
            modifier = Modifier.fillMaxWidth(),
        )

        BrandSecondaryButton(
            text = if (editor.saving) {
                stringResource(R.string.common_saving)
            } else {
                stringResource(R.string.common_save)
            },
            // AC2 again, at the last gate: a handle the server has already said
            // is taken cannot be submitted at all.
            enabled = !editor.saving &&
                editor.handleAvailable != false &&
                editor.bio.length <= MAX_BIO,
            modifier = Modifier.fillMaxWidth(),
        ) { onSave() }
        BrandSecondaryButton(
            text = stringResource(R.string.common_cancel),
            enabled = !editor.saving,
            modifier = Modifier.fillMaxWidth(),
        ) { onCancel() }
    }
}

/** Mirrors MAX_BIO in services/edge-functions/src/routes/verified.ts. */
private const val MAX_BIO = 280

@Composable
private fun VerifiedSwitchRow(
    label: String,
    detail: String,
    checked: Boolean,
    enabled: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().cardStyle(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyLarge)
            Text(
                detail,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Switch(checked = checked, enabled = enabled, onCheckedChange = onCheckedChange)
    }
}
