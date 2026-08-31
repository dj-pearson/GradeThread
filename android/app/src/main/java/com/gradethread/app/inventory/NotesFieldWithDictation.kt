package com.gradethread.app.inventory

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import com.gradethread.app.ui.text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.core.content.ContextCompat
import com.gradethread.app.R
import com.gradethread.app.speech.DictationController
import com.gradethread.app.ui.components.ValidatedTextField
import com.gradethread.app.ui.theme.Spacing

/**
 * US-1331: the notes field with hands-free dictation.
 *
 * The mic is only rendered when the device can actually recognize speech —
 * an affordance that can only ever error is worse than no affordance.
 * Permission is requested on TAP, not on screen entry: asking for the
 * microphone the moment someone opens an item form reads as an overreach.
 */
@Composable
fun NotesFieldWithDictation(
    value: String,
    onValueChange: (String) -> Unit,
    dictation: DictationCallbacks,
    modifier: Modifier = Modifier,
) {
    // US-2976: `context` also renders the dictation error below.
    // LaunchedEffect is not a composable scope, so that one goes through
    // UiMessage.text(context) rather than the composable renderer.
    val context = LocalContext.current
    val controller = remember { DictationController(context) }
    val available = remember { controller.isAvailable() }
    val dictationState by controller.state.collectAsState()
    val finalTranscript by controller.finalTranscript.collectAsState()

    val listening = dictationState is DictationController.State.Listening
    // Hoisted: `semantics { }` is not a composable scope.
    val dictationHint = stringResource(
        if (listening) R.string.notes_dictate_stop else R.string.notes_dictate_start,
    )

    // Always release the mic and audio focus when the screen goes away —
    // stop() is idempotent, so this is safe even if never started.
    //
    // endDictation() first: partials never autosave, so leaving mid-session
    // would otherwise drop everything dictated since the last final. It
    // no-ops when dictation wasn't running.
    DisposableEffect(controller) {
        onDispose {
            dictation.end()
            controller.reset()
        }
    }

    // Partials stream live into the field; they never autosave (see the
    // view model), so Room isn't written once per syllable.
    LaunchedEffect(dictationState) {
        when (val s = dictationState) {
            is DictationController.State.Listening ->
                if (s.transcript.isNotEmpty()) {
                    dictation.transcript(s.transcript, false)
                }
            is DictationController.State.Failed -> {
                dictation.error(s.error.message.text(context))
                dictation.end()
            }
            DictationController.State.Idle -> Unit
        }
    }

    // The final arrives in the same turn listening flips off, so it is
    // handled on its own channel rather than behind an is-listening guard.
    LaunchedEffect(finalTranscript) {
        finalTranscript?.let {
            dictation.transcript(it, true)
            controller.consumeFinal()
        }
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            dictation.begin()
            controller.start()
        } else {
            controller.permissionDenied()
        }
    }

    Column(modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ValidatedTextField(
                value = value,
                onValueChange = onValueChange,
                label = stringResource(R.string.common_notes),
                singleLine = false,
                modifier = Modifier.weight(1f),
            )
            if (available) {
                IconButton(
                    onClick = {
                        if (listening) {
                            controller.stop()
                            dictation.end()
                        } else {
                            val granted = ContextCompat.checkSelfPermission(
                                context,
                                Manifest.permission.RECORD_AUDIO,
                            ) == PackageManager.PERMISSION_GRANTED
                            if (granted) {
                                dictation.begin()
                                controller.start()
                            } else {
                                permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                            }
                        }
                    },
                    modifier = Modifier.semantics { contentDescription = dictationHint },
                ) {
                    Icon(
                        // The module ships only the CORE icon set, which has
                        // no Mic glyph. PlayArrow/Close read as start/stop;
                        // swapping in a real mic means adding
                        // material-icons-extended, which isn't worth a whole
                        // dependency for one glyph today.
                        imageVector = if (listening) {
                            Icons.Outlined.Close
                        } else {
                            Icons.Outlined.PlayArrow
                        },
                        contentDescription = null,
                        tint = if (listening) {
                            MaterialTheme.colorScheme.error
                        } else {
                            MaterialTheme.colorScheme.primary
                        },
                    )
                }
            }
        }
        if (listening) {
            Text(
                text = stringResource(R.string.notes_listening),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(top = Spacing.xxs),
            )
        }
    }
}
