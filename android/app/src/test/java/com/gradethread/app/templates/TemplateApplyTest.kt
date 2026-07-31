package com.gradethread.app.templates

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-1373: what applying a template does, and — more importantly — what it
 * refuses to do to work the seller already did.
 */
class TemplateApplyTest {

    private fun template(
        id: String = "t1",
        name: String = "Denim",
        condition: String? = "USED_GOOD",
        conditionDescription: String? = null,
        specifics: Map<String, String> = emptyMap(),
        isDefault: Boolean = false,
        sortOrder: Int = 0,
    ) = ListingTemplate(
        id = id,
        name = name,
        ebayCondition = condition,
        conditionDescription = conditionDescription,
        itemSpecifics = specifics,
        isDefault = isDefault,
        sortOrder = sortOrder,
    )

    private fun target(
        condition: String = "USED_EXCELLENT",
        conditionDescription: String = "",
        specifics: Map<String, List<String>> = emptyMap(),
    ) = TemplateApply.Target(condition, conditionDescription, specifics)

    // ── Condition ────────────────────────────────────────────────────────────

    @Test
    fun `the template's condition wins because that is what was asked for`() {
        val result = TemplateApply.apply(template(condition = "USED_GOOD"), target())

        assertEquals("USED_GOOD", result.target.condition)
        assertTrue(result.changed.contains("condition"))
    }

    @Test
    fun `a template with no condition leaves the one already chosen`() {
        val result = TemplateApply.apply(template(condition = null), target("LIKE_NEW"))

        assertEquals("LIKE_NEW", result.target.condition)
        assertFalse(result.changed.contains("condition"))
    }

    @Test
    fun `a blank condition is treated as no condition, not as a value`() {
        val result = TemplateApply.apply(template(condition = "   "), target("LIKE_NEW"))
        assertEquals("LIKE_NEW", result.target.condition)
    }

    @Test
    fun `an empty template never wipes condition notes the seller wrote`() {
        val result = TemplateApply.apply(
            template(conditionDescription = null),
            target(conditionDescription = "Small mark on the left cuff"),
        )

        assertEquals("Small mark on the left cuff", result.target.conditionDescription)
        assertTrue(result.changed.isEmpty() || !result.changed.contains("condition notes"))
    }

    @Test
    fun `a template's condition notes replace what was there`() {
        val result = TemplateApply.apply(
            template(conditionDescription = "Standard pre-owned wording"),
            target(conditionDescription = "old"),
        )

        assertEquals("Standard pre-owned wording", result.target.conditionDescription)
        assertTrue(result.changed.contains("condition notes"))
    }

    // ── Item specifics ───────────────────────────────────────────────────────

    @Test
    fun `specifics fill blanks`() {
        val result = TemplateApply.apply(
            template(specifics = mapOf("Sleeve Length" to "Long Sleeve", "Fit" to "Regular")),
            target(),
        )

        assertEquals(listOf("Long Sleeve"), result.target.specifics["Sleeve Length"])
        assertEquals(listOf("Regular"), result.target.specifics["Fit"])
        assertTrue(result.changed.any { it.contains("2 specifics") })
    }

    @Test
    fun `a specific the seller already set is kept and named`() {
        // A value measured off the actual garment beats a template's generic
        // default. Saying so beats silently doing nothing.
        val result = TemplateApply.apply(
            template(specifics = mapOf("Size" to "M")),
            target(specifics = mapOf("Size" to listOf("L"))),
        )

        assertEquals(listOf("L"), result.target.specifics["Size"])
        assertEquals(listOf("Size"), result.keptExisting)
        assertTrue(result.message.contains("Kept what you'd already set"))
    }

    @Test
    fun `a specific already holding the template's own value is not reported as kept`() {
        // Nothing was overridden, so there is nothing to explain.
        val result = TemplateApply.apply(
            template(specifics = mapOf("Size" to "M")),
            target(specifics = mapOf("Size" to listOf("M"))),
        )

        assertTrue(result.keptExisting.isEmpty())
        assertTrue(result.changed.none { it.contains("specific") })
    }

    @Test
    fun `an empty existing value counts as blank and gets filled`() {
        val result = TemplateApply.apply(
            template(specifics = mapOf("Fit" to "Slim")),
            target(specifics = mapOf("Fit" to listOf("", "  "))),
        )

        assertEquals(listOf("Slim"), result.target.specifics["Fit"])
    }

    @Test
    fun `blank template entries set nothing`() {
        val result = TemplateApply.apply(
            template(condition = null, specifics = mapOf("Fit" to "  ", "" to "x")),
            target(),
        )

        assertTrue(result.target.specifics.isEmpty())
        assertTrue(result.changed.isEmpty())
        assertEquals("That template didn't have anything to add.", result.message)
    }

    @Test
    fun `values are trimmed on the way in`() {
        val result = TemplateApply.apply(
            template(specifics = mapOf("  Fit  " to "  Slim  ")),
            target(),
        )
        assertEquals(listOf("Slim"), result.target.specifics["Fit"])
    }

    @Test
    fun `specifics the template doesn't mention are untouched`() {
        val result = TemplateApply.apply(
            template(specifics = mapOf("Fit" to "Slim")),
            target(specifics = mapOf("Colour" to listOf("Blue"))),
        )

        assertEquals(listOf("Blue"), result.target.specifics["Colour"])
        assertEquals(listOf("Slim"), result.target.specifics["Fit"])
    }

    @Test
    fun `applying a template that changes nothing says so`() {
        val result = TemplateApply.apply(
            template(condition = "USED_GOOD", specifics = mapOf("Size" to "M")),
            target(condition = "USED_GOOD", specifics = mapOf("Size" to listOf("L"))),
        )

        assertTrue(result.changed.isEmpty())
        assertTrue(result.message.contains("Nothing changed"))
    }

    // ── Picker behaviour ─────────────────────────────────────────────────────

    @Test
    fun `only an explicit default is pre-selected`() {
        // Picking the first one alphabetically would silently apply somebody
        // else's boilerplate to a listing.
        val none = listOf(template(id = "a", name = "A"), template(id = "b", name = "B"))
        assertNull(TemplateApply.preselected(none))

        val withDefault = none + template(id = "c", name = "C", isDefault = true)
        assertEquals("c", TemplateApply.preselected(withDefault)!!.id)
    }

    @Test
    fun `templates order by sort order then name`() {
        val ordered = TemplateApply.ordered(
            listOf(
                template(id = "3", name = "zebra", sortOrder = 0),
                template(id = "1", name = "Apple", sortOrder = 0),
                template(id = "2", name = "First", sortOrder = -1),
            ),
        )
        assertEquals(listOf("2", "1", "3"), ordered.map { it.id })
    }

    // ── Draft + summary ──────────────────────────────────────────────────────

    @Test
    fun `a template needs a name`() {
        assertFalse(TemplateDraft(name = "   ").isValid)
        assertTrue(TemplateDraft(name = "Denim").isValid)
        assertTrue(TemplateDraft().validationMessage!!.contains("name"))
    }

    @Test
    fun `blank specifics are dropped before saving`() {
        val draft = TemplateDraft(
            name = "T",
            itemSpecifics = mapOf("Fit" to "Slim", "Colour" to "  ", "  " to "x"),
        )
        assertEquals(mapOf("Fit" to "Slim"), draft.cleanSpecifics)
    }

    @Test
    fun `renaming a specific keeps its value and drops the old key`() {
        val draft = TemplateDraft(name = "T", itemSpecifics = mapOf("Fit" to "Slim"))
            .renameSpecific("Fit", "Style")

        assertEquals(mapOf("Style" to "Slim"), draft.itemSpecifics)
        assertEquals(
            draft,
            draft.renameSpecific("Missing", "Other"),
        )
    }

    @Test
    fun `a draft round-trips from a saved template`() {
        val draft = TemplateDraft.of(
            template(
                condition = "USED_GOOD",
                conditionDescription = "Notes",
                specifics = mapOf("Fit" to "Slim"),
                isDefault = true,
                sortOrder = 3,
            ),
        )

        assertEquals("USED_GOOD", draft.ebayCondition)
        assertEquals("Notes", draft.conditionDescription)
        assertEquals(mapOf("Fit" to "Slim"), draft.itemSpecifics)
        assertTrue(draft.isDefault)
        assertEquals(3, draft.sortOrder)
        assertEquals("", draft.descriptionTemplate)
    }

    @Test
    fun `a template that sets nothing says so instead of showing a blank line`() {
        assertEquals("Sets nothing yet", template(condition = null).summary)
        assertTrue(
            template(condition = "USED_GOOD", specifics = mapOf("Fit" to "Slim"))
                .summary
                .contains("Used good"),
        )
        assertTrue(
            template(condition = null, specifics = mapOf("Fit" to "Slim"))
                .summary
                .contains("1 specific"),
        )
    }

    @Test
    fun `policies are counted for the summary`() {
        val withPolicies = ListingTemplate(
            id = "t",
            name = "T",
            returnPolicyId = "r1",
            shippingPolicyId = "s1",
        )
        assertEquals(2, withPolicies.policyCount)
        assertTrue(withPolicies.summary.contains("2 policies"))
    }
}
