package com.gradethread.app.autolister

import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import com.gradethread.app.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-2964: the block list's pure half. Mirrors
 * `src/lib/__tests__/description-blocks.test.ts` and the iOS
 * `DescriptionBlocksTests`, because a block array written on a phone is read by
 * the web composer and the three have to agree about what a move, a toggle and a
 * whole-string apply mean.
 */
class DescriptionBlocksTest {

    private val json = DescriptionBlocksService.json

    private fun sample() = DescriptionBlocks.DEFAULTS

    // ── Wire shape ──────────────────────────────────────────────────────────

    @Test
    fun `an absent on defaults to true and an absent src to user`() {
        val blocks = json.decodeFromString(
            ListSerializer(DescriptionBlock.serializer()),
            """[{"key":"intro","text":"Hi"}]""",
        )
        assertEquals(1, blocks.size)
        assertTrue(blocks[0].on)
        assertEquals(DescriptionBlockSource.USER, blocks[0].src)
        assertEquals("Hi", blocks[0].text)
    }

    /**
     * Version skew is a hard failure, not a silent drop. Quietly discarding a key
     * this build does not know would delete a section of the seller's description
     * without telling anyone - the edge `parseBlocks` rejects the same payload
     * for the same reason.
     */
    @Test
    fun `an unknown block key fails the decode`() {
        assertThrows(SerializationException::class.java) {
            json.decodeFromString(
                ListSerializer(DescriptionBlock.serializer()),
                """[{"key":"shipping","on":true,"src":"user"}]""",
            )
        }
    }

    /**
     * `sep` is the bytes that precede the block in the rendered output, so an
     * absent one must stay absent - writing a null would renormalise the
     * whitespace of every converted listing on its first save.
     */
    @Test
    fun `an absent optional is not written, and sep round-trips`() {
        val bare = DescriptionBlock(DescriptionBlockKey.FACTS, true, DescriptionBlockSource.SYSTEM)
        val encoded = json.encodeToString(DescriptionBlock.serializer(), bare)
        assertFalse(encoded.contains("sep"))
        assertFalse(encoded.contains("null"))
        assertTrue(encoded.contains("\"on\":true"))

        val kept = DescriptionBlock(DescriptionBlockKey.TEXT, text = "x", sep = "\n")
        val round = json.decodeFromString(
            DescriptionBlock.serializer(),
            json.encodeToString(DescriptionBlock.serializer(), kept),
        )
        assertEquals("\n", round.sep)
    }

    /** A payload the server has never seen must still be readable next release. */
    @Test
    fun `an unknown FIELD is ignored rather than failing the decode`() {
        val block = json.decodeFromString(
            DescriptionBlock.serializer(),
            """{"key":"intro","on":true,"src":"ai","futureField":7}""",
        )
        assertEquals(DescriptionBlockKey.INTRO, block.key)
    }

    // ── Array operations ────────────────────────────────────────────────────

    @Test
    fun `a toggle keeps the block at its index`() {
        val blocks = sample()
        val index = 4 // measurements
        val off = DescriptionBlocks.toggle(blocks, index)
        assertFalse(off[index].on)
        assertEquals(DescriptionBlockKey.MEASUREMENTS, off[index].key)
        assertEquals(blocks, DescriptionBlocks.toggle(off, index))
    }

    @Test
    fun `an out-of-range index changes nothing`() {
        val blocks = sample()
        assertEquals(blocks, DescriptionBlocks.toggle(blocks, 99))
        assertEquals(blocks, DescriptionBlocks.setText(blocks, -1, "x"))
        assertEquals(blocks, DescriptionBlocks.remove(blocks, 99))
    }

    @Test
    fun `setText touches only that row`() {
        val blocks = sample()
        val out = DescriptionBlocks.setText(blocks, 0, "Fresh intro")
        assertEquals("Fresh intro", out[0].text)
        assertEquals(blocks.drop(1), out.drop(1))
    }

    /**
     * The pinned rows hold their indices whatever the move does, which is what
     * stops a revise-in-place accumulating a second facts block (US-2682).
     */
    @Test
    fun `a move keeps the pinned rows at their indices`() {
        val blocks = sample()
        val out = DescriptionBlocks.move(blocks, 0, 3)
        assertEquals(blocks.size, out.size)
        assertEquals(DescriptionBlockKey.CREDENTIALS, out[7].key)
        assertEquals(DescriptionBlockKey.FACTS, out[8].key)
        assertEquals(DescriptionBlockKey.INTRO, out[3].key)
        assertEquals(DescriptionBlockKey.FEATURES, out[0].key)
    }

    @Test
    fun `a move onto or from a pinned row is refused`() {
        val blocks = sample()
        assertEquals(blocks, DescriptionBlocks.move(blocks, 0, 8))
        assertEquals(blocks, DescriptionBlocks.move(blocks, 8, 0))
        assertEquals(blocks, DescriptionBlocks.move(blocks, 2, 2))
    }

    @Test
    fun `a snippet lands above the pinned rows and carries only the ref`() {
        val out = DescriptionBlocks.addSnippet(sample(), "snip-1")
        assertEquals(DescriptionBlockKey.SNIPPET, out[7].key)
        assertEquals("snip-1", out[7].ref)
        assertEquals(DescriptionBlockKey.CREDENTIALS, out[8].key)
        assertEquals(DescriptionBlockKey.FACTS, out[9].key)
        // The body lives on the account, so editing the snippet changes every
        // listing pointing at it with no write to any listing row.
        assertNull(out[7].text)
    }

    @Test
    fun `remove drops only that row`() {
        val blocks = DescriptionBlocks.addSnippet(sample(), "snip-1")
        val out = DescriptionBlocks.remove(blocks, 7)
        assertEquals(blocks.size - 1, out.size)
        assertFalse(out.any { it.key == DescriptionBlockKey.SNIPPET })
    }

    // ── Whole-string writers ────────────────────────────────────────────────

    @Test
    fun `stripRenderedBlocks removes marked sections and the open-only tail`() {
        val text = buildString {
            append("Great tee.\n\n")
            append("<!--gradethread-measurements-->Chest: 42 in<!--/gradethread-measurements-->")
            append("\n\nMore prose.\n\n")
            append("<!--gradethread-seller-credentials--><div>Verified</div>")
        }
        val out = DescriptionBlocks.stripRenderedBlocks(text)
        assertFalse(out.contains("gradethread"))
        assertFalse(out.contains("Chest: 42 in"))
        assertFalse(out.contains("Verified"))
        assertTrue(out.startsWith("Great tee."))
        assertTrue(out.contains("More prose."))
    }

    @Test
    fun `applyWholeText fills the intro and clears the other prose rows`() {
        val blocks = sample().toMutableList()
        blocks[1] = blocks[1].copy(text = "Old features")
        blocks[3] = blocks[3].copy(text = "Old condition")

        val out = DescriptionBlocks.applyWholeText(blocks, "A brand new description.")
        assertEquals(DescriptionBlockKey.INTRO, out[0].key)
        assertEquals("A brand new description.", out[0].text)
        assertTrue(out[0].on)
        assertEquals("", out[1].text)
        assertEquals("", out[3].text)
        // Derived rows are untouched - that is the point of the split.
        assertEquals(blocks[4], out[4])
        assertEquals(blocks[8], out[8])
    }

    @Test
    fun `applyWholeText strips the rendered markers out of the string`() {
        val text = "Body copy.\n\n<!--gradethread-seller-credentials--><div>V</div>"
        val out = DescriptionBlocks.applyWholeText(sample(), text)
        assertEquals("Body copy.", out[0].text)
    }

    @Test
    fun `applyWholeText inserts an intro when the array has none`() {
        val blocks = listOf(
            DescriptionBlock(DescriptionBlockKey.FACTS, true, DescriptionBlockSource.SYSTEM),
        )
        val out = DescriptionBlocks.applyWholeText(blocks, "Prose.")
        assertEquals(2, out.size)
        assertEquals(DescriptionBlockKey.INTRO, out[0].key)
        assertEquals(DescriptionBlockSource.AI, out[0].src)
        assertEquals("Prose.", out[0].text)
    }

    // ── Row summaries ───────────────────────────────────────────────────────

    @Test
    fun `derived rows say what they will show`() {
        val ctx = DescriptionBlocks.RowContext(
            attributes = mapOf("brand" to "Patagonia", "size" to " ", "color" to "Navy"),
            measurementCount = 1,
            unit = "in",
            gradeValue = 8.5,
        )
        val blocks = sample()

        // US-2976: the attributes row is one part PER FILLED FIELD, and the
        // blank size is the point - a field with only whitespace in it must not
        // appear in a list that says what the section will show.
        val attributes = DescriptionBlocks.describe(blocks[2], ctx)
        assertEquals(
            listOf(R.string.block_attr_brand, R.string.block_attr_color),
            attributes.parts.map { it.res },
        )

        // The UNIT picks the plurals resource, and the count picks the form.
        val inches = DescriptionBlocks.describe(blocks[4], ctx).parts.single()
        assertEquals(R.plurals.block_measurement_count_in, inches.res)
        assertEquals(1, inches.quantity)

        val grade = DescriptionBlocks.describe(blocks[5], ctx).parts.single()
        assertEquals(R.string.block_grade_value, grade.res)
        // The number keeps Locale.US on purpose: 8.5 out of 10 is the same
        // scale everywhere, and a decimal comma would read as a different one.
        assertEquals(listOf<Any>("8.5"), grade.args)

        val metric = ctx.copy(measurementCount = 3, unit = "cm")
        val centimetres = DescriptionBlocks.describe(blocks[4], metric).parts.single()
        assertEquals(R.plurals.block_measurement_count_cm, centimetres.res)
        assertEquals(3, centimetres.quantity)

        val ungraded = ctx.copy(gradeValue = null)
        assertEquals(
            R.string.block_not_graded,
            DescriptionBlocks.describe(blocks[5], ungraded).parts.single().res,
        )
        assertEquals(
            R.string.block_not_graded,
            DescriptionBlocks.describe(blocks[6], ungraded).parts.single().res,
        )
    }

    /**
     * A ref missing from a list that has not loaded is not a deleted snippet, and
     * saying so would libel a perfectly good section for as long as the request
     * takes.
     */
    @Test
    fun `a snippet waits for the name list before calling itself deleted`() {
        val block = DescriptionBlock(
            DescriptionBlockKey.SNIPPET,
            true,
            DescriptionBlockSource.ACCOUNT,
            ref = "gone",
        )
        // Not loaded yet: the neutral wording, and NOT the deleted one.
        val waiting = DescriptionBlocks
            .describe(block, DescriptionBlocks.RowContext())
            .parts
            .single()
        assertEquals(R.string.block_snippet, waiting.res)
        assertNull(waiting.detail)

        // Loaded and still missing: now it is genuinely deleted, and a
        // DIFFERENT resource says so.
        assertEquals(
            R.string.block_snippet_deleted,
            DescriptionBlocks.describe(
                block,
                DescriptionBlocks.RowContext(snippetsLoaded = true),
            ).parts.single().res,
        )

        // The snippet's own name is the seller's word and goes through as
        // `detail`, untranslated.
        assertEquals(
            "Returns policy",
            DescriptionBlocks.describe(
                block,
                DescriptionBlocks.RowContext(
                    snippetNames = mapOf("gone" to "Returns policy"),
                    snippetsLoaded = true,
                ),
            ).parts.single().detail,
        )
    }

    @Test
    fun `a per-listing override beats the snippet name`() {
        val block = DescriptionBlock(
            DescriptionBlockKey.SNIPPET,
            true,
            DescriptionBlockSource.ACCOUNT,
            text = "My own words",
            ref = "s1",
        )
        assertEquals(
            "My own words",
            DescriptionBlocks.describe(
                block,
                DescriptionBlocks.RowContext(
                    snippetNames = mapOf("s1" to "Returns policy"),
                    snippetsLoaded = true,
                ),
            ).parts.single().detail,
        )
    }

    // ── Row metadata ────────────────────────────────────────────────────────

    @Test
    fun `the pinned, editable and regenerable sets match the web`() {
        assertEquals(
            listOf(DescriptionBlockKey.CREDENTIALS, DescriptionBlockKey.FACTS),
            DescriptionBlocks.PINNED_KEYS,
        )
        assertEquals(
            listOf(
                DescriptionBlockKey.INTRO,
                DescriptionBlockKey.FEATURES,
                DescriptionBlockKey.CONDITION,
                DescriptionBlockKey.SNIPPET,
                DescriptionBlockKey.TEXT,
            ),
            DescriptionBlocks.EDITABLE_KEYS,
        )
        assertEquals(
            listOf(
                DescriptionBlockKey.INTRO,
                DescriptionBlockKey.FEATURES,
                DescriptionBlockKey.CONDITION,
            ),
            DescriptionBlocks.REGENERABLE_KEYS,
        )
        assertTrue(DescriptionBlocks.isRemovable(DescriptionBlockKey.TEXT))
        assertFalse(DescriptionBlocks.isRemovable(DescriptionBlockKey.MEASUREMENTS))
    }

    /** The wire spelling is the contract with the edge; a rename breaks a save. */
    @Test
    fun `the serialised key is the lowercase name the edge accepts`() {
        val encoded = json.encodeToString(
            DescriptionBlock.serializer(),
            DescriptionBlock(DescriptionBlockKey.MEASUREMENTS, src = DescriptionBlockSource.ITEM),
        )
        assertTrue(encoded.contains("\"key\":\"measurements\""))
        assertTrue(encoded.contains("\"src\":\"item\""))
    }
}
