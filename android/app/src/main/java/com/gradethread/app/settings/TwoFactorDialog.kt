package com.gradethread.app.settings

import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.R

/**
 * US-2685: turn on two-factor, and get this session elevated.
 *
 * TWO JOBS ON ONE SCREEN, and keeping them distinct is the point. Enrollment
 * mints a factor; ELEVATION raises the current session to aal2. A member who
 * enrolled last week and signed in cold today has a verified factor and an aal1
 * token, so they are blocked on every request while the screen would otherwise
 * show a reassuring "Enabled" badge and offer them nothing to do. That case gets
 * a code box, not a badge.
 *
 * RECOVERY CODES ARE NOT HERE (AC6) and the screen says so rather than staying
 * silent. They are one-time backups for losing THIS phone; minting them on the
 * device they protect is not a backup, it is a copy in the same box.
 */
@Composable
fun TwoFactorDialog(onDismiss: () -> Unit, store: TwoFactorStore = hiltViewModel()) {
    val state by store.state.collectAsState()
    var code by rememberSaveable { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = { if (!state.busy) onDismiss() },
        title = { Text(stringResource(titleFor(state.phase))) },
        text = {
            Column(Modifier.fillMaxWidth()) {
                when (val phase = state.phase) {
                    TwoFactorStore.Phase.Loading ->
                        CircularProgressIndicator(Modifier.padding(Spacing8))

                    TwoFactorStore.Phase.Disabled -> Text(
                        stringResource(R.string.twofactor_body_disabled),
                        style = MaterialTheme.typography.bodyMedium,
                    )

                    is TwoFactorStore.Phase.Enrolling -> {
                        Text(
                            stringResource(R.string.twofactor_body_enrolling),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        // The SECRET, not a QR bitmap. A code the seller can
                        // long-press and paste works in every authenticator and
                        // needs no camera pointed at the phone it is running on
                        // - which is the awkward case a QR creates on mobile.
                        Text(
                            phase.secret,
                            style = MaterialTheme.typography.titleMedium,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth().padding(vertical = Spacing8),
                        )
                        CodeField(code) { code = it }
                    }

                    is TwoFactorStore.Phase.Enabled -> if (phase.aal2) {
                        Text(
                            stringResource(R.string.twofactor_body_verified),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Text(
                            stringResource(R.string.twofactor_body_recovery_codes),
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(top = Spacing8),
                        )
                    } else {
                        // AC3. The honest sentence: they ARE enrolled, and this
                        // session still is not verified. Saying "enabled" here
                        // and stopping is what leaves someone staring at a badge
                        // while every request is refused.
                        Text(
                            stringResource(R.string.twofactor_body_needs_elevation),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        CodeField(code) { code = it }
                    }

                    is TwoFactorStore.Phase.Failed -> Text(
                        stringResource(phase.message),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }

                state.error?.let {
                    Text(
                        stringResource(it),
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(top = Spacing8),
                    )
                }
                state.notice?.let {
                    Text(
                        stringResource(it),
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(top = Spacing8),
                    )
                }
            }
        },
        confirmButton = {
            when (val phase = state.phase) {
                TwoFactorStore.Phase.Disabled -> TextButton(
                    onClick = store::enroll,
                    enabled = !state.busy,
                ) { Text(stringResource(R.string.twofactor_turn_on)) }

                is TwoFactorStore.Phase.Enrolling -> TextButton(
                    onClick = {
                        store.confirmEnrollment(code)
                        code = ""
                    },
                    enabled = !state.busy && isSubmittable(code),
                ) { Text(stringResource(R.string.twofactor_verify)) }

                is TwoFactorStore.Phase.Enabled -> if (phase.aal2) {
                    TextButton(onClick = onDismiss, enabled = !state.busy) {
                        Text(stringResource(R.string.twofactor_done))
                    }
                } else {
                    TextButton(
                        onClick = {
                            store.elevate(code)
                            code = ""
                        },
                        enabled = !state.busy && isSubmittable(code),
                    ) { Text(stringResource(R.string.twofactor_verify)) }
                }

                else -> TextButton(onClick = store::refresh, enabled = !state.busy) {
                    Text(stringResource(R.string.twofactor_try_again))
                }
            }
        },
        dismissButton = {
            val phase = state.phase
            val removable = phase is TwoFactorStore.Phase.Enabled ||
                phase is TwoFactorStore.Phase.Enrolling
            if (removable) {
                TextButton(onClick = store::remove, enabled = !state.busy) {
                    Text(stringResource(R.string.twofactor_turn_off))
                }
            } else {
                TextButton(onClick = onDismiss, enabled = !state.busy) {
                    Text(stringResource(R.string.twofactor_close))
                }
            }
        },
    )
}

@Composable
private fun CodeField(code: String, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = code,
        // Normalised on the way IN as well as at verify: the field should not
        // let someone type a seventh digit and wonder why nothing happens.
        onValueChange = { onChange(TwoFactorPolicy.normalizeCode(it).take(CODE_LENGTH)) },
        label = { Text(stringResource(R.string.twofactor_code_label)) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
        modifier = Modifier.fillMaxWidth().padding(top = Spacing8),
    )
}

/**
 * US-2908: returns the DECISION, not the words.
 *
 * A plain function outside a @Composable cannot call `stringResource`, and the
 * bare-strings guard cannot see English hiding behind `Text(titleFor(...))`
 * either — the literal is not at a sink. Returning a `@StringRes` id is the
 * pattern US-2368 settled on for exactly this shape, and it keeps the phase-to-
 * title mapping unit-testable without asserting on English.
 */
@StringRes
private fun titleFor(phase: TwoFactorStore.Phase): Int = when (phase) {
    is TwoFactorStore.Phase.Enabled ->
        if (phase.aal2) R.string.twofactor_title_on else R.string.twofactor_title_verify_signin
    is TwoFactorStore.Phase.Enrolling -> R.string.twofactor_title_setup
    else -> R.string.twofactor_title_default
}

/** Exactly six digits. Nothing shorter is a TOTP code, so nothing shorter submits. */
internal fun isSubmittable(code: String): Boolean = TwoFactorPolicy.normalizeCode(code).length == CODE_LENGTH

internal const val CODE_LENGTH = 6

private val Spacing8 = 8.dp
