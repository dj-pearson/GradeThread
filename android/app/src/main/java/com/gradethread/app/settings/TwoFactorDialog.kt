package com.gradethread.app.settings

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
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel

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
fun TwoFactorDialog(
    onDismiss: () -> Unit,
    store: TwoFactorStore = hiltViewModel(),
) {
    val state by store.state.collectAsState()
    var code by rememberSaveable { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = { if (!state.busy) onDismiss() },
        title = { Text(titleFor(state.phase)) },
        text = {
            Column(Modifier.fillMaxWidth()) {
                when (val phase = state.phase) {
                    TwoFactorStore.Phase.Loading ->
                        CircularProgressIndicator(Modifier.padding(Spacing8))

                    TwoFactorStore.Phase.Disabled -> Text(
                        "Two-factor adds a six-digit code from an authenticator app " +
                            "on top of your password. If your workspace requires it, " +
                            "you need this before you can do anything else.",
                        style = MaterialTheme.typography.bodyMedium,
                    )

                    is TwoFactorStore.Phase.Enrolling -> {
                        Text(
                            "Add this key to your authenticator app, then enter the " +
                                "six digits it shows.",
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
                            "Two-factor is on and this session is verified.",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Text(
                            "Recovery codes live on gradethread.com, in Settings. " +
                                "They are your way back in if you lose this phone, so " +
                                "they are not kept on it.",
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(top = Spacing8),
                        )
                    } else {
                        // AC3. The honest sentence: they ARE enrolled, and this
                        // session still is not verified. Saying "enabled" here
                        // and stopping is what leaves someone staring at a badge
                        // while every request is refused.
                        Text(
                            "Two-factor is on for your account, but this sign-in has " +
                                "not been verified yet. Enter the current six digits " +
                                "from your authenticator app.",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        CodeField(code) { code = it }
                    }

                    is TwoFactorStore.Phase.Failed -> Text(
                        phase.message,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }

                state.error?.let {
                    Text(
                        it,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(top = Spacing8),
                    )
                }
                state.notice?.let {
                    Text(
                        it,
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
                ) { Text("Turn on") }

                is TwoFactorStore.Phase.Enrolling -> TextButton(
                    onClick = { store.confirmEnrollment(code); code = "" },
                    enabled = !state.busy && isSubmittable(code),
                ) { Text("Verify") }

                is TwoFactorStore.Phase.Enabled -> if (phase.aal2) {
                    TextButton(onClick = onDismiss, enabled = !state.busy) { Text("Done") }
                } else {
                    TextButton(
                        onClick = { store.elevate(code); code = "" },
                        enabled = !state.busy && isSubmittable(code),
                    ) { Text("Verify") }
                }

                else -> TextButton(onClick = store::refresh, enabled = !state.busy) {
                    Text("Try again")
                }
            }
        },
        dismissButton = {
            val phase = state.phase
            val removable = phase is TwoFactorStore.Phase.Enabled ||
                phase is TwoFactorStore.Phase.Enrolling
            if (removable) {
                TextButton(onClick = store::remove, enabled = !state.busy) {
                    Text("Turn off")
                }
            } else {
                TextButton(onClick = onDismiss, enabled = !state.busy) { Text("Close") }
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
        label = { Text("Six-digit code") },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
        modifier = Modifier.fillMaxWidth().padding(top = Spacing8),
    )
}

private fun titleFor(phase: TwoFactorStore.Phase): String = when (phase) {
    is TwoFactorStore.Phase.Enabled -> if (phase.aal2) "Two-factor is on" else "Verify this sign-in"
    is TwoFactorStore.Phase.Enrolling -> "Set up two-factor"
    else -> "Two-factor authentication"
}

/** Exactly six digits. Nothing shorter is a TOTP code, so nothing shorter submits. */
internal fun isSubmittable(code: String): Boolean =
    TwoFactorPolicy.normalizeCode(code).length == CODE_LENGTH

internal const val CODE_LENGTH = 6

private val Spacing8 = 8.dp
