package com.gradethread.app.speech

/**
 * US-1331: how a live transcript folds into the text already in the field
 * (iOS `mergedDictationNotes`).
 *
 * The rule that matters: every partial merges against the SAME anchor — the
 * field's contents snapshotted BEFORE dictation started — so each partial
 * REPLACES the previous one instead of concatenating. That makes the merge
 * idempotent, and lets the recognizer's final correction ("with tag" →
 * "with tags") land cleanly over the partial it supersedes.
 *
 * Appending each partial instead would produce
 * "small stain small stain on small stain on the collar".
 */
object DictationMerge {

    fun mergeNotes(anchor: String, transcript: String): String {
        if (anchor.isEmpty()) return transcript
        if (transcript.isEmpty()) return anchor
        // Don't double up a space the user already typed.
        val separator = if (anchor.endsWith(" ")) "" else " "
        return anchor + separator + transcript
    }
}
