package com.gradethread.app.inventory

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

/**
 * US-1347: keeping `ebay_aspects` and the item's own fields in step.
 *
 * All pure. The provenance model is the interesting part: an aspect can come
 * from three places, and the whole point of tracking that is so a re-save never
 * silently discards something a person or the AI put there.
 */
object AspectSync {

    /**
     * Where a value came from. `UNFILLED` is COMPUTED (a required aspect with
     * no value) and never stored — matching migration 00184's decision.
     */
    enum class Provenance(val wire: String, val badge: String) {
        INVENTORY_DERIVED("inventory_derived", "Auto"),
        AI_EXTRACTED("ai_extracted", "AI"),
        MANUAL("manual", "You"),
        ;

        companion object {
            fun from(wire: String?): Provenance? = entries.firstOrNull { it.wire == wire }
        }
    }

    /**
     * eBay rejects an item specific longer than this, and the failure surfaces
     * as an unpublishable offer rather than a field error.
     *
     * The edge enforces it at its own chokepoint (`capAspectValuesForEbay`), so
     * this is NOT a second enforcement point — it exists so the editor can warn
     * the seller BEFORE they save that their 80-character value will be cut,
     * instead of silently losing 15 characters somewhere downstream.
     */
    const val EBAY_ASPECT_VALUE_MAX_LEN = 65

    fun willBeTruncated(value: String): Boolean =
        value.trim().length > EBAY_ASPECT_VALUE_MAX_LEN

    /**
     * Project the structured columns onto their aspects.
     *
     * Runs on EVERY item save, mirroring the web `projectColumnAspects`: the
     * columns OWN their aspects, so brand/size/color/material/style always
     * agree with what the listing will publish. A cleared column removes its
     * aspect and its provenance entry rather than leaving a stale value that
     * the seller can no longer see the source of.
     *
     * Aspects NOT backed by a column are untouched — that is what stops a plain
     * re-save from wiping an AI-extracted or hand-typed specific.
     */
    fun projectColumnAspects(
        draft: ItemDraft,
        existingAspects: Map<String, List<String>>,
        existingSources: Map<String, Provenance>,
    ): Pair<Map<String, List<String>>, Map<String, Provenance>> {
        val aspects = existingAspects.toMutableMap()
        val sources = existingSources.toMutableMap()

        for (entry in AspectRegistry.columnEntries) {
            val name = entry.canonicalAspect
            val value = when (entry.field) {
                "brand" -> draft.brand
                "size" -> draft.size
                "color" -> draft.color
                "material" -> draft.material
                "style" -> draft.style
                else -> ""
            }.trim()

            if (value.isNotEmpty()) {
                aspects[name] = listOf(value)
                sources[name] = Provenance.INVENTORY_DERIVED
            } else {
                aspects.remove(name)
                sources.remove(name)
            }
        }
        return aspects to sources
    }

    /**
     * US-2494: the aspects to send as `knownAspects` on a re-derive.
     *
     * Only the ones somebody OWNS — typed or AI-filled. Sending the whole map
     * would tell the server every auto-derived aspect is already answered, and
     * the refill would then never refresh a value whose column changed, which
     * is the entire point of running it.
     */
    fun preserved(
        aspects: Map<String, List<String>>,
        sources: Map<String, Provenance>,
    ): Map<String, List<String>> = aspects
        .mapValues { (_, values) -> values.map { it.trim() }.filter { it.isNotEmpty() } }
        .filter { (name, values) ->
            values.isNotEmpty() &&
                (sources[name] == Provenance.MANUAL || sources[name] == Provenance.AI_EXTRACTED)
        }

    /**
     * US-2494: fold the server's deterministic gap-fills into the current map.
     *
     * A derived value lands only where the aspect is BLANK or already
     * `inventory_derived` — a manual or AI value is somebody's answer and the
     * caller has already excluded it from `knownAspects`, so re-deriving over
     * it here would undo a decision nobody asked to revisit.
     *
     * [validNames] is the category's own aspect list. When it is non-empty a
     * derived name outside it is skipped, so a response that raced a category
     * change cannot inject a specific this category does not have.
     */
    fun reconcileDerived(
        aspects: Map<String, List<String>>,
        sources: Map<String, Provenance>,
        derived: Map<String, List<String>>,
        validNames: List<String> = emptyList(),
    ): Pair<Map<String, List<String>>, Map<String, Provenance>> {
        val allowed = validNames.map { it.trim() }.filter { it.isNotEmpty() }.toSet()
        val nextAspects = aspects.toMutableMap()
        val nextSources = sources.toMutableMap()
        for ((name, raw) in derived) {
            if (allowed.isNotEmpty() && name !in allowed) continue
            val values = raw.map { it.trim() }.filter { it.isNotEmpty() }
            if (values.isEmpty()) continue
            val existing = nextAspects[name].orEmpty().filter { it.isNotBlank() }
            if (existing.isNotEmpty() && sources[name] != Provenance.INVENTORY_DERIVED) continue
            nextAspects[name] = values
            nextSources[name] = Provenance.INVENTORY_DERIVED
        }
        return nextAspects to nextSources
    }

    /**
     * US-2494: force the COLUMNS' authority over the five aspects they own,
     * after [reconcileDerived] has done the gap-filling.
     *
     * Brand, Size, Color, Material and Style are projections of item columns
     * rather than independent aspects. [reconcileDerived] protects manual and
     * AI values, which is right for every other aspect and wrong for these
     * five: it let an AI-filled Brand outrank the seller's own correction on
     * the item page, so fixing Brand there left the eBay specific stale and
     * they had to type it in both places.
     *
     * The SERVER decides membership ([columnOwned] are the aspects whose column
     * currently holds a value, [columnCleared] the ones whose column was
     * blanked), so the mapping stays in the shared registry and no Kotlin table
     * can drift from it.
     */
    fun applyColumnAuthority(
        aspects: Map<String, List<String>>,
        sources: Map<String, Provenance>,
        derived: Map<String, List<String>>,
        columnOwned: List<String>,
        columnCleared: List<String>,
    ): Pair<Map<String, List<String>>, Map<String, Provenance>> {
        val nextAspects = aspects.toMutableMap()
        val nextSources = sources.toMutableMap()
        for (name in columnOwned) {
            val values = derived[name].orEmpty().map { it.trim() }.filter { it.isNotEmpty() }
            // No value means the server named the aspect but derived nothing
            // for it. Leaving it alone is right: columnCleared is how a blanked
            // column asks for a removal.
            if (values.isEmpty()) continue
            nextAspects[name] = values
            nextSources[name] = Provenance.INVENTORY_DERIVED
        }
        for (name in columnCleared) {
            nextAspects.remove(name)
            nextSources.remove(name)
        }
        return nextAspects to nextSources
    }

    /**
     * A manual edit from the aspects editor.
     *
     * Marked MANUAL, which outranks both other sources — a value someone typed
     * deliberately must survive the next derivation pass.
     */
    /**
     * US-2411: merge the model's proposals into the specifics.
     *
     * **Only EMPTY specifics are filled, and a previous AI fill can be
     * replaced.** A value the seller typed is theirs: a model that disagreed
     * with it would otherwise quietly win on a screen where nothing says a
     * value changed. Re-running the extraction can overwrite its own earlier
     * answer, because that one was never anybody's opinion but the model's.
     * Same rule as the web picker's merge.
     *
     * Returns the aspects, the sources, and HOW MANY were filled — the count is
     * what lets the screen say "added 4 specifics" instead of appearing to do
     * nothing when the model had nothing new.
     */
    fun fillFromAi(
        aspects: Map<String, List<String>>,
        sources: Map<String, Provenance>,
        suggestions: Map<String, List<String>>,
    ): Triple<Map<String, List<String>>, Map<String, Provenance>, Int> {
        val nextAspects = aspects.toMutableMap()
        val nextSources = sources.toMutableMap()
        var filled = 0
        for ((name, raw) in suggestions) {
            val values = raw.map { it.trim() }.filter { it.isNotEmpty() }
            if (values.isEmpty()) continue
            val existing = nextAspects[name].orEmpty()
            val replaceable = existing.isEmpty() || sources[name] == Provenance.AI_EXTRACTED
            if (!replaceable) continue
            if (existing == values) continue
            nextAspects[name] = values
            nextSources[name] = Provenance.AI_EXTRACTED
            filled += 1
        }
        return Triple(nextAspects, nextSources, filled)
    }

    fun setManual(
        aspects: Map<String, List<String>>,
        sources: Map<String, Provenance>,
        name: String,
        values: List<String>,
    ): Pair<Map<String, List<String>>, Map<String, Provenance>> {
        val cleaned = values.map { it.trim() }.filter { it.isNotEmpty() }
        val nextAspects = aspects.toMutableMap()
        val nextSources = sources.toMutableMap()
        if (cleaned.isEmpty()) {
            nextAspects.remove(name)
            nextSources.remove(name)
        } else {
            nextAspects[name] = cleaned
            nextSources[name] = Provenance.MANUAL
        }
        return nextAspects to nextSources
    }

    /**
     * Drop provenance entries whose aspect no longer has a value, so the stored
     * map never goes stale against the value map (web `pruneSources`).
     */
    fun pruneSources(
        sources: Map<String, Provenance>,
        aspects: Map<String, List<String>>,
    ): Map<String, Provenance> =
        sources.filterKeys { !aspects[it].isNullOrEmpty() }

    /**
     * Required aspects with no value — the pre-publish checklist, and the same
     * rule the edge applies at publish time so the two can't disagree.
     *
     * @param required the category spec's required aspect names.
     */
    fun requiredMissing(
        required: List<String>,
        aspects: Map<String, List<String>>,
    ): List<String> = required
        .map { it.trim() }
        .filter { it.isNotEmpty() && aspects[it].isNullOrEmpty() }

    // ── jsonb round trip ─────────────────────────────────────────────────

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    /** Decode `ebay_aspects`: name → values, dropping empties. */
    fun decodeAspects(raw: String?): Map<String, List<String>> {
        if (raw.isNullOrBlank()) return emptyMap()
        return runCatching {
            (json.parseToJsonElement(raw) as? JsonObject)
                ?.mapNotNull { (name, element) ->
                    val values = runCatching {
                        element.jsonArray.mapNotNull { item ->
                            item.jsonPrimitive.content.trim().takeIf { it.isNotEmpty() }
                        }
                    }.getOrDefault(emptyList())
                    if (values.isEmpty()) null else name to values
                }
                ?.toMap()
                .orEmpty()
        }.getOrDefault(emptyMap())
    }

    fun encodeAspects(aspects: Map<String, List<String>>): String? {
        val kept = aspects.filterValues { it.isNotEmpty() }
        if (kept.isEmpty()) return null
        return JsonObject(
            kept.mapValues { (_, values) -> JsonArray(values.map { JsonPrimitive(it) }) },
        ).toString()
    }

    /**
     * Decode `ebay_aspect_sources`.
     *
     * An UNRECOGNISED provenance is dropped rather than guessed at: the map is
     * additive and a missing key already means "source unknown", so a value
     * this client doesn't understand should not be re-badged as something it
     * isn't.
     */
    fun decodeSources(raw: String?): Map<String, Provenance> {
        if (raw.isNullOrBlank()) return emptyMap()
        return runCatching {
            (json.parseToJsonElement(raw) as? JsonObject)
                ?.mapNotNull { (name, element) ->
                    Provenance.from(element.jsonPrimitive.content)?.let { name to it }
                }
                ?.toMap()
                .orEmpty()
        }.getOrDefault(emptyMap())
    }

    fun encodeSources(sources: Map<String, Provenance>): String? {
        if (sources.isEmpty()) return null
        return JsonObject(sources.mapValues { JsonPrimitive(it.value.wire) }).toString()
    }
}
