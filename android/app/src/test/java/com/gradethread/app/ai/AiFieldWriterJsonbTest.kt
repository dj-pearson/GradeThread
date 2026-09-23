package com.gradethread.app.ai

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * US-3360: an Android AI apply leaves every jsonb entry it did not touch
 * exactly as another client wrote it.
 *
 * The writer reads `attributes` and `ai_field_sources`, merges the keys the
 * seller confirmed, and writes the whole document back, because a jsonb
 * UPDATE replaces it. It used to read every entry as a string, so the write
 * turned the provenance objects edge, web and iOS store into bare strings and
 * quoted every numeric attribute. This runs the same read, merge and write
 * shape on a real row and compares the untouched entries to the input text.
 */
class AiFieldWriterJsonbTest {

    private val brandSource = """{"source":"photo:tag","confidence":0.92,"accepted":true}"""

    private val rowJson = """
        {
          "attributes": {"pit_to_pit": 21.5, "lined": true, "tags": ["vintage", "usa"], "fit": "Regular"},
          "ai_field_sources": {"brand": $brandSource, "color": "photo:front"}
        }
    """.trimIndent()

    private val current = Json.decodeFromString<AiItemRow>(rowJson).toCurrentJsonb()

    @Test
    fun anUntouchedProvenanceObjectSurvivesAnApply() {
        val written = JsonObject(
            AiItemFields.mergeFieldSources(
                existing = current.aiFieldSources,
                sources = mapOf("size" to "photo:tag"),
            ),
        )
        // Byte for byte: the object another client wrote, not its toString.
        assertEquals(brandSource, written.getValue("brand").toString())
        assertEquals("\"photo:front\"", written.getValue("color").toString())
        assertEquals("\"photo:tag\"", written.getValue("size").toString())
    }

    @Test
    fun untouchedAttributesKeepTheirTypes() {
        val written = JsonObject(
            AiItemFields.mergeAttributes(
                existing = current.attributes,
                updates = mapOf("fit" to "Slim"),
            ),
        )
        assertEquals(
            """{"pit_to_pit":21.5,"lined":true,"tags":["vintage","usa"],"fit":"Slim"}""",
            written.toString(),
        )
    }

    @Test
    fun aRowWithNoChangesWritesBackWhatItRead() {
        // The strongest form of the rule: merging nothing is the identity.
        val original = Json.parseToJsonElement(rowJson).jsonObject
        assertEquals(
            original.getValue("attributes"),
            JsonObject(AiItemFields.mergeAttributes(current.attributes, emptyMap())),
        )
        assertEquals(
            original.getValue("ai_field_sources"),
            JsonObject(AiItemFields.mergeFieldSources(current.aiFieldSources, emptyMap())),
        )
    }

    @Test
    fun aMissingRowReadsAsEmptyDocuments() {
        val empty = Json.decodeFromString<AiItemRow>("{}").toCurrentJsonb()
        assertEquals(CurrentJsonb(), empty)
    }
}
