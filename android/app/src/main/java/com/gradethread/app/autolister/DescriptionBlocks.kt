package com.gradethread.app.autolister

import androidx.annotation.StringRes
import com.gradethread.app.R
import com.gradethread.app.ui.UiMessage

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * US-2964: the Android half of the description block list.
 *
 * The RENDERER is edge-only by design, so nothing here turns blocks into a
 * description. What lives here is the part a client owns: what a row is called,
 * whether it holds its position, whether it can be edited in place, and the
 * array operations the list performs. All pure, so the behaviour is unit-tested
 * without a device.
 *
 * The web equivalent is `src/lib/description-blocks.ts` and the iOS one is
 * `ios/Packages/GradeThreadCore/.../DescriptionBlocks.swift`. Keep the three in
 * lockstep - a block array written by one client is read by the others.
 */

/**
 * Which kind of description block a [DescriptionBlock] is.
 *
 * The kind decides who owns the content. `intro`/`features`/`condition` are
 * written by the AI and edited by the seller; `attributes`/`measurements`/
 * `grade`/`disclosure`/`credentials`/`facts` are DERIVED at render time and
 * store no text, which is what makes them impossible to drift from the fields
 * they show; `snippet` points at a `listing_snippets` row; `text` is one-off
 * typing (and is what a legacy description parses into).
 */
@Serializable
enum class DescriptionBlockKey {
    @SerialName("intro")
    INTRO,

    @SerialName("features")
    FEATURES,

    @SerialName("condition")
    CONDITION,

    @SerialName("attributes")
    ATTRIBUTES,

    @SerialName("measurements")
    MEASUREMENTS,

    @SerialName("grade")
    GRADE,

    @SerialName("disclosure")
    DISCLOSURE,

    @SerialName("credentials")
    CREDENTIALS,

    @SerialName("facts")
    FACTS,

    @SerialName("snippet")
    SNIPPET,

    @SerialName("text")
    TEXT,
}

/** Who owns a block's content. */
@Serializable
enum class DescriptionBlockSource {
    @SerialName("ai")
    AI,

    @SerialName("item")
    ITEM,

    @SerialName("grade")
    GRADE,

    @SerialName("seller")
    SELLER,

    @SerialName("system")
    SYSTEM,

    @SerialName("account")
    ACCOUNT,

    @SerialName("user")
    USER,
}

/**
 * One entry of `listings.description_blocks` (migration 00678).
 *
 * Array order is render order, with one exception the renderer enforces: the
 * `facts` block is always emitted last, because US-2682 needs it at a fixed
 * position for revise-in-place to replace it rather than accumulate a copy.
 *
 * An UNKNOWN `key` fails the decode rather than being dropped. A key this build
 * does not recognise is version skew, and quietly discarding the block would
 * delete a section of the seller's description without telling anyone - the edge
 * `parseBlocks` rejects the same payload for the same reason.
 */
@Serializable
data class DescriptionBlock(
    val key: DescriptionBlockKey,
    /** Off blocks keep their position so toggling back on restores the order. */
    val on: Boolean = true,
    val src: DescriptionBlockSource = DescriptionBlockSource.USER,
    /**
     * Free-form content. Absent on derived blocks; on `snippet` it overrides the
     * referenced body.
     */
    val text: String? = null,
    /** `attributes` only: which item columns to show, in order. */
    val fields: List<String>? = null,
    /** `measurements` only: the length unit to render ("in" or "cm"). */
    val unit: String? = null,
    /** `snippet` only: the `listing_snippets.id` this block renders. */
    val ref: String? = null,
    /**
     * US-2957: the exact bytes that precede this block in the rendered output.
     * Defaults to "\n\n" server-side. A legacy parse records what was really
     * there, which is what lets convert-on-open reproduce a live description
     * byte for byte instead of silently renormalising its whitespace.
     *
     * LOAD-BEARING. Round-trip it untouched; dropping it on a save rewrites the
     * buyer-facing whitespace of every converted listing.
     */
    val sep: String? = null,
)

/** Row metadata and the array operations the list performs. */
object DescriptionBlocks {

    /** Row heading per block type. */
    @StringRes
    fun label(key: DescriptionBlockKey): Int = when (key) {
        DescriptionBlockKey.INTRO -> R.string.block_intro
        DescriptionBlockKey.FEATURES -> R.string.block_features
        DescriptionBlockKey.CONDITION -> R.string.block_condition
        DescriptionBlockKey.ATTRIBUTES -> R.string.block_attributes
        DescriptionBlockKey.MEASUREMENTS -> R.string.block_measurements
        DescriptionBlockKey.GRADE -> R.string.block_grade
        DescriptionBlockKey.DISCLOSURE -> R.string.block_disclosure
        DescriptionBlockKey.CREDENTIALS -> R.string.block_credentials
        DescriptionBlockKey.FACTS -> R.string.block_facts
        DescriptionBlockKey.SNIPPET -> R.string.block_snippet
        DescriptionBlockKey.TEXT -> R.string.block_text
    }

    /** The small plain-text tag that says who owns a row's content. */
    @StringRes
    fun label(src: DescriptionBlockSource): Int = when (src) {
        DescriptionBlockSource.AI -> R.string.block_src_ai
        DescriptionBlockSource.ITEM -> R.string.block_src_item
        DescriptionBlockSource.GRADE -> R.string.block_src_grade
        DescriptionBlockSource.SELLER -> R.string.block_src_seller
        DescriptionBlockSource.SYSTEM -> R.string.block_src_system
        DescriptionBlockSource.ACCOUNT -> R.string.block_src_account
        DescriptionBlockSource.USER -> R.string.block_src_user
    }

    /**
     * Rows that hold their position and carry no reorder control.
     *
     * `facts` is pinned because US-2682 needs it last so a revise on a live
     * listing REPLACES it rather than accumulating a second copy - the renderer
     * moves it last regardless, and a movable row that silently snaps back is
     * worse than one that never moved. `credentials` is server-gated: the seller
     * cannot edit its content, and its position next to the facts block is what
     * the credentials-refresh cron expects to find.
     */
    val PINNED_KEYS = listOf(DescriptionBlockKey.CREDENTIALS, DescriptionBlockKey.FACTS)

    fun isPinned(key: DescriptionBlockKey) = key in PINNED_KEYS

    /** Blocks whose text the seller types. Everything else is derived. */
    val EDITABLE_KEYS = listOf(
        DescriptionBlockKey.INTRO,
        DescriptionBlockKey.FEATURES,
        DescriptionBlockKey.CONDITION,
        DescriptionBlockKey.SNIPPET,
        DescriptionBlockKey.TEXT,
    )

    fun isEditable(key: DescriptionBlockKey) = key in EDITABLE_KEYS

    /** The three blocks the AI writes, and the only ones /regenerate touches. */
    val REGENERABLE_KEYS = listOf(
        DescriptionBlockKey.INTRO,
        DescriptionBlockKey.FEATURES,
        DescriptionBlockKey.CONDITION,
    )

    fun isRegenerable(key: DescriptionBlockKey) = key in REGENERABLE_KEYS

    /**
     * Rows the seller ADDED, and so the only ones a delete is offered on. The
     * nine standard sections are switched off instead, which keeps their
     * position so toggling back on restores it.
     */
    fun isRemovable(key: DescriptionBlockKey) = key == DescriptionBlockKey.SNIPPET || key == DescriptionBlockKey.TEXT

    /**
     * Flip one row on or off.
     *
     * The block keeps its index. That is the whole contract: a seller who
     * switches measurements off, reorders nothing, and switches it back on gets
     * it back where it was rather than at the bottom.
     */
    fun toggle(blocks: List<DescriptionBlock>, index: Int): List<DescriptionBlock> {
        if (index !in blocks.indices) return blocks
        return blocks.mapIndexed { i, b -> if (i == index) b.copy(on = !b.on) else b }
    }

    /** Set the stored text of one row, leaving every other entry alone. */
    fun setText(blocks: List<DescriptionBlock>, index: Int, text: String): List<DescriptionBlock> {
        if (index !in blocks.indices) return blocks
        return blocks.mapIndexed { i, b -> if (i == index) b.copy(text = text) else b }
    }

    /**
     * Reorder, with the pinned rows nailed to the indices they hold.
     *
     * A plain move would slide a pinned row up by one whenever a reorder crossed
     * it, which is exactly the accumulate-a-second-facts-block failure US-2682
     * fixed. So the movable rows are lifted out, moved among themselves, and the
     * pinned ones are put back at their original indices. A move that starts or
     * ends on a pinned row is refused outright.
     */
    fun move(blocks: List<DescriptionBlock>, from: Int, to: Int): List<DescriptionBlock> {
        if (from == to) return blocks
        if (from !in blocks.indices || to !in blocks.indices) return blocks
        if (isPinned(blocks[from].key) || isPinned(blocks[to].key)) return blocks

        val pinned = blocks.withIndex().filter { isPinned(it.value.key) }
        val movableIndices = blocks.indices.filter { !isPinned(blocks[it].key) }
        val movable = movableIndices.map { blocks[it] }.toMutableList()

        val fromSlot = movableIndices.indexOf(from)
        val toSlot = movableIndices.indexOf(to)
        if (fromSlot < 0 || toSlot < 0) return blocks

        movable.add(toSlot, movable.removeAt(fromSlot))
        for ((i, b) in pinned) movable.add(i, b)
        return movable
    }

    /**
     * Put a snippet block into the array, above the pinned rows.
     *
     * Above them because `credentials` and `facts` close the description and stay
     * where they are; a new section dropped after `facts` would be moved back by
     * the renderer anyway, and the row would appear to land somewhere it did not.
     *
     * The block stores ONLY the ref. That is the whole point of snippets: the
     * body lives on the account, so editing it there changes every listing
     * pointing at it, with no write to any listing row.
     */
    fun addSnippet(blocks: List<DescriptionBlock>, ref: String): List<DescriptionBlock> {
        val block = DescriptionBlock(
            key = DescriptionBlockKey.SNIPPET,
            on = true,
            src = DescriptionBlockSource.ACCOUNT,
            ref = ref,
        )
        val firstPinned = blocks.indexOfFirst { isPinned(it.key) }
        if (firstPinned < 0) return blocks + block
        return blocks.subList(0, firstPinned) + block + blocks.subList(firstPinned, blocks.size)
    }

    /** Drop the row at [index]. Only ever offered on rows the seller added. */
    fun remove(blocks: List<DescriptionBlock>, index: Int): List<DescriptionBlock> {
        if (index !in blocks.indices) return blocks
        return blocks.filterIndexed { i, _ -> i != index }
    }

    // ── Whole-string writers ────────────────────────────────────────────────

    /**
     * Markers the edge renderer emits. A whole-description string that already
     * carries one has to be stripped before it becomes block text, or the block
     * that owns that section would print it a second time.
     */
    private val MARKER_SECTIONS = listOf(
        "<!--gradethread-measurements-->" to "<!--/gradethread-measurements-->",
        "<!--gradethread-facts-->" to "<!--/gradethread-facts-->",
    )

    /**
     * These have no closing tag - they run to the end of the string or to the
     * next marker - so everything from the first one onward is dropped.
     */
    private val OPEN_ONLY_MARKERS = listOf(
        "<!--gradethread-disclosure-->",
        "<!--gradethread-seller-credentials-->",
    )

    /** Strip every rendered block out of a whole-description string. */
    fun stripRenderedBlocks(text: String): String {
        var out = text
        for ((start, end) in MARKER_SECTIONS) {
            while (true) {
                val a = out.indexOf(start)
                if (a < 0) break
                val b = out.indexOf(end, a)
                out = if (b < 0) out.substring(0, a) else out.substring(0, a) + out.substring(b + end.length)
            }
        }
        for (marker in OPEN_ONLY_MARKERS) {
            val at = out.indexOf(marker)
            if (at >= 0) out = out.substring(0, at)
        }
        return out.trim()
    }

    /**
     * Fold a whole-description string into the block array.
     *
     * Some surfaces hand over ONE string standing for the entire prose part of a
     * description - a garment template, an AI rewrite, a bulk text edit. Blocks
     * are the source of truth now, so that string has to land in a block or the
     * next save renders it away. It goes into `intro`, and `features` and
     * `condition` are CLEARED: the string already says whatever those two would
     * have, and leaving them would print the same prose twice.
     *
     * Derived rows are untouched - that is the point of the split.
     *
     * NO ANDROID CALLER YET, deliberately. The web composer and the iOS canvas
     * both produce whole-string descriptions (template, AI rewrite) and both go
     * through this; the Android drafts screen has neither, and its bulk editor
     * offers a title and a price only. It stays here because this file is the
     * third copy of one contract and a missing operation is how the three drift
     * - `DescriptionBlocksTest` holds it to the same behaviour as the other two.
     */
    fun applyWholeText(blocks: List<DescriptionBlock>, text: String): List<DescriptionBlock> {
        val prose = stripRenderedBlocks(text)
        var seenIntro = false
        val out = blocks.map { block ->
            when {
                block.key == DescriptionBlockKey.INTRO && !seenIntro -> {
                    seenIntro = true
                    block.copy(on = true, text = prose)
                }
                block.key == DescriptionBlockKey.FEATURES ||
                    block.key == DescriptionBlockKey.CONDITION -> block.copy(text = "")
                else -> block
            }
        }
        if (seenIntro) return out
        return listOf(
            DescriptionBlock(
                key = DescriptionBlockKey.INTRO,
                on = true,
                src = DescriptionBlockSource.AI,
                text = prose,
            ),
        ) + out
    }

    // ── Row summaries ───────────────────────────────────────────────────────

    /** Everything a row summary reads that is not on the block itself. */
    data class RowContext(
        /** Item columns the attributes row can show, keyed by field name. */
        val attributes: Map<String, String> = emptyMap(),
        val measurementCount: Int = 0,
        /** "in" or "cm". */
        val unit: String = "in",
        val gradeValue: Double? = null,
        /** `listing_snippets.id` -> name, for the snippet row's heading. */
        val snippetNames: Map<String, String> = emptyMap(),
        /**
         * Whether [snippetNames] has actually been fetched. A ref missing from a
         * list that has not loaded is NOT a deleted snippet, and saying so would
         * put "deleted, renders nothing" under a perfectly good section for as
         * long as the request takes.
         */
        val snippetsLoaded: Boolean = false,
    )

    private val ATTRIBUTE_LABELS = mapOf(
        "brand" to R.string.block_attr_brand,
        "size" to R.string.block_attr_size,
        "color" to R.string.block_attr_color,
        "material" to R.string.block_attr_material,
        "style" to R.string.block_attr_style,
    )

    /**
     * The one-line summary shown on a row.
     *
     * Derived rows say what they WILL show rather than showing it, because the
     * row is a control and the preview below is where the actual bytes live.
     */
    fun describe(block: DescriptionBlock, ctx: RowContext): RowSummary = when (block.key) {
        DescriptionBlockKey.INTRO,
        DescriptionBlockKey.FEATURES,
        DescriptionBlockKey.CONDITION,
        DescriptionBlockKey.TEXT,
        // The seller's own words, shown exactly as typed - which is what
        // `detail` is for. R.string.block_empty covers the blank case.
        -> one(R.string.block_empty, detail = block.text.orEmpty().trim().ifBlank { null })

        DescriptionBlockKey.SNIPPET -> {
            // The per-listing override wins, exactly as the renderer resolves it
            // - which is why an override survives the snippet it overrides being
            // renamed, edited or deleted.
            val own = block.text.orEmpty().trim()
            val ref = block.ref.orEmpty()
            val name = ctx.snippetNames[ref]
            when {
                own.isNotEmpty() -> one(R.string.block_empty, detail = own)
                ref.isEmpty() -> one(R.string.block_empty)
                // The snippet's own name, which the seller wrote.
                name != null -> one(R.string.block_snippet, detail = name)
                // Deleting a snippet leaves the block in place and renders
                // nothing, which is the safe outcome and an invisible one. The
                // row is where it gets said.
                ctx.snippetsLoaded -> one(R.string.block_snippet_deleted)
                else -> one(R.string.block_snippet)
            }
        }

        DescriptionBlockKey.ATTRIBUTES -> {
            val fields = block.fields ?: listOf("brand", "size", "color", "material")
            val filled = fields.filter { ctx.attributes[it].orEmpty().isNotBlank() }
            if (filled.isEmpty()) {
                one(R.string.block_no_attributes)
            } else {
                // US-2976: one part per field, joined on screen. A field this
                // build has no label for falls back to its own wire name rather
                // than vanishing from a list that claims to be complete.
                RowSummary(
                    filled.map { field ->
                        val res = ATTRIBUTE_LABELS[field]
                        if (res == null) {
                            UiMessage(R.string.block_attributes, detail = field)
                        } else {
                            UiMessage(res)
                        }
                    },
                )
            }
        }

        DescriptionBlockKey.MEASUREMENTS -> {
            val n = ctx.measurementCount
            if (n == 0) {
                one(R.string.block_no_measurements)
            } else {
                // US-2976: "value" versus "values" is a plurals resource, and
                // the UNIT picks which plurals resource - the two cannot be one
                // string with the unit substituted, because a language may
                // decline the noun differently for each.
                val unit = block.unit ?: ctx.unit
                RowSummary(
                    listOf(
                        UiMessage(
                            if (unit == "cm") {
                                R.plurals.block_measurement_count_cm
                            } else {
                                R.plurals.block_measurement_count_in
                            },
                            args = listOf(n),
                            quantity = n,
                        ),
                    ),
                )
            }
        }

        DescriptionBlockKey.GRADE ->
            ctx.gradeValue
                ?.let {
                    // Locale.US on the NUMBER only: the grade is 8.5 out of 10
                    // everywhere, and a decimal comma here would read as a
                    // different scale rather than as the same one localized.
                    one(
                        R.string.block_grade_value,
                        args = listOf(String.format(java.util.Locale.US, "%.1f", it)),
                    )
                }
                ?: one(R.string.block_not_graded)

        DescriptionBlockKey.DISCLOSURE ->
            if (ctx.gradeValue == null) {
                one(R.string.block_not_graded)
            } else {
                one(R.string.block_disclosure_summary)
            }

        // The server decides whether this seller has one and what it says, so the
        // row promises the section rather than previewing bytes it cannot know.
        DescriptionBlockKey.CREDENTIALS -> one(R.string.block_credentials_summary)

        DescriptionBlockKey.FACTS -> one(R.string.block_facts_summary)
    }

    private fun one(res: Int, detail: String? = null, args: List<Any> = emptyList()) =
        RowSummary(listOf(UiMessage(res, detail = detail, args = args)))

    /**
     * What a row says under its heading.
     *
     * US-2976: a LIST, because the attributes row names each filled field and
     * joining them is the step that has to be translatable. Every other row has
     * exactly one part; the screen joins with R.string.block_separator.
     */
    data class RowSummary(val parts: List<UiMessage>)

    /**
     * The starting order for a listing that has no row yet.
     *
     * Mirrors `defaultBlocks()` in
     * services/edge-functions/src/lib/description-blocks.ts, which is
     * authoritative - this copy exists only so the list can draw rows before the
     * server has answered.
     */
    val DEFAULTS = listOf(
        DescriptionBlock(DescriptionBlockKey.INTRO, true, DescriptionBlockSource.AI, text = ""),
        DescriptionBlock(DescriptionBlockKey.FEATURES, true, DescriptionBlockSource.AI, text = ""),
        DescriptionBlock(
            DescriptionBlockKey.ATTRIBUTES,
            true,
            DescriptionBlockSource.ITEM,
            fields = listOf("brand", "size", "color", "material"),
        ),
        DescriptionBlock(DescriptionBlockKey.CONDITION, true, DescriptionBlockSource.AI, text = ""),
        DescriptionBlock(DescriptionBlockKey.MEASUREMENTS, true, DescriptionBlockSource.ITEM),
        DescriptionBlock(DescriptionBlockKey.GRADE, false, DescriptionBlockSource.GRADE),
        DescriptionBlock(DescriptionBlockKey.DISCLOSURE, true, DescriptionBlockSource.GRADE),
        DescriptionBlock(DescriptionBlockKey.CREDENTIALS, true, DescriptionBlockSource.SELLER),
        DescriptionBlock(DescriptionBlockKey.FACTS, true, DescriptionBlockSource.SYSTEM),
    )
}
