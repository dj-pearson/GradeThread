package com.gradethread.app.inventory

import androidx.compose.runtime.Immutable

/**
 * The four things dictation reports back (US-2902 AC3).
 *
 * ⚠ CALLBACKS RATHER THAN THE VIEWMODEL ITSELF. Handing a ViewModel down
 * through a second composable is what detekt's ViewModelForwarding refuses, and
 * it is right to: this field needs four functions, not the whole object, and
 * naming them makes it obvious that a partial transcript and a final one are
 * different events.
 */
@Immutable
data class DictationCallbacks(
    val begin: () -> Unit = {},
    val end: () -> Unit = {},
    /** [isFinal] false is a live partial; true is the committed text. */
    val transcript: (String, Boolean) -> Unit = { _, _ -> },
    val error: (String) -> Unit = {},
)
