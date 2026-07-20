package com.gradethread.app.speech

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * US-1331: the anchor-merge contract (iOS SpeechDictationTests). The reason
 * this is a pure function with its own test file is that getting it wrong
 * produces "small stain small stain on small stain on the collar" — visible
 * only while actually dictating, which is the hardest thing to catch by hand.
 */
class DictationMergeTest {

    @Test
    fun anEmptyAnchorYieldsTheTranscriptAlone() {
        assertEquals("small stain", DictationMerge.mergeNotes("", "small stain"))
    }

    @Test
    fun anExistingNoteIsExtendedWithASingleSpace() {
        assertEquals(
            "Bought at market small stain",
            DictationMerge.mergeNotes("Bought at market", "small stain"),
        )
    }

    @Test
    fun aTrailingSpaceIsNotDoubled() {
        assertEquals(
            "Bought at market small stain",
            DictationMerge.mergeNotes("Bought at market ", "small stain"),
        )
    }

    @Test
    fun successivePartialsReplaceRatherThanAccumulate() {
        // THE invariant. Every partial merges against the SAME anchor, so
        // feeding a growing transcript never compounds.
        val anchor = "Note:"
        assertEquals("Note: small", DictationMerge.mergeNotes(anchor, "small"))
        assertEquals("Note: small stain", DictationMerge.mergeNotes(anchor, "small stain"))
        assertEquals(
            "Note: small stain on collar",
            DictationMerge.mergeNotes(anchor, "small stain on collar"),
        )
    }

    @Test
    fun theFinalCorrectionReplacesThePartialCleanly() {
        val anchor = "Note:"
        val partial = DictationMerge.mergeNotes(anchor, "with tag")
        val final = DictationMerge.mergeNotes(anchor, "with tags")
        assertEquals("Note: with tag", partial)
        // Not "Note: with tag with tags".
        assertEquals("Note: with tags", final)
    }

    @Test
    fun mergingIsIdempotent() {
        val anchor = "Note:"
        val once = DictationMerge.mergeNotes(anchor, "hello")
        val twice = DictationMerge.mergeNotes(anchor, "hello")
        assertEquals(once, twice)
    }

    @Test
    fun anEmptyTranscriptLeavesTheAnchorUntouched() {
        // A recognizer that heard nothing must not append a stray space.
        assertEquals("Bought at market", DictationMerge.mergeNotes("Bought at market", ""))
        assertEquals("", DictationMerge.mergeNotes("", ""))
    }
}
