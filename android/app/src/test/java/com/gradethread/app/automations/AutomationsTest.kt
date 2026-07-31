package com.gradethread.app.automations

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

/**
 * US-1362: automation rules.
 *
 * These fire on a condition and can END listings while nobody is watching, so
 * two things are pinned hard: the sentence a rule shows must match what the
 * server will do, and a filter that silently becomes "everything" must never
 * happen quietly.
 */
class AutomationsTest {

    private fun rule(
        name: String = "Stale trim",
        trigger: AutomationTrigger = AutomationTrigger("days_listed_gt", 30, 7),
        action: AutomationAction = AutomationAction("price_drop_pct", 10.0, 10),
        scope: AutomationScope = AutomationScope("all"),
        active: Boolean = true,
    ) = AutomationRule(
        id = "r1",
        name = name,
        trigger = trigger,
        action = action,
        scope = scope,
        isActive = active,
    )

    // ── how a rule reads ─────────────────────────────────────────────────────

    @Test
    fun `each trigger reads as the condition it actually checks`() {
        assertEquals(
            "listed more than 30 days",
            Automations.triggerSummary(AutomationTrigger("days_listed_gt", 30, 7)),
        )
        assertEquals(
            "no views after 14 days",
            Automations.triggerSummary(AutomationTrigger("no_views_in_days", 14, 7)),
        )
        assertEquals(
            "fewer than 2 watchers after 21 days",
            Automations.triggerSummary(AutomationTrigger("watchers_lt_after_days", 21, 7, 2)),
        )
    }

    @Test
    fun `each action reads as what it does`() {
        assertEquals(
            "drop price 10%",
            Automations.actionSummary(AutomationAction("price_drop_pct", 10.0, 10)),
        )
        assertEquals(
            "set promo rate to 7.5%",
            Automations.actionSummary(AutomationAction("set_promo_rate_pct", 7.5)),
        )
        assertEquals("end the listing", Automations.actionSummary(AutomationAction("end_listing")))
    }

    @Test
    fun `the whole rule reads as one sentence`() {
        assertEquals(
            "When listed more than 30 days, drop price 10% (all active listings).",
            Automations.sentence(rule()),
        )
    }

    @Test
    fun `an unscoped end-listing rule is flagged before it runs`() {
        // It can take a seller's whole shop down on a timer. Legitimate to want,
        // catastrophic by accident.
        val danger = rule(action = AutomationAction("end_listing"), scope = AutomationScope("all"))
        assertNotNull(Automations.scopeWarning(danger))

        val scoped = rule(
            action = AutomationAction("end_listing"),
            scope = AutomationScope("filter", "and", listOf(AutomationScopeRule("brand", "eq", "Nike"))),
        )
        assertNull(Automations.scopeWarning(scoped))
        // An inactive rule isn't doing anything to warn about.
        assertNull(Automations.scopeWarning(danger.copy(isActive = false)))
    }

    @Test
    fun `a price-drop rule is not flagged the same way`() {
        assertNull(Automations.scopeWarning(rule()))
    }

    // ── validity ─────────────────────────────────────────────────────────────

    @Test
    fun `a rule needs a name`() {
        assertEquals("Give the rule a name.", Automations.validationError(AutomationDraft(name = " ")))
    }

    @Test
    fun `percentages respect the server's own ceilings`() {
        val bigDrop = AutomationDraft(name = "x", actionType = "price_drop_pct", actionPct = 95.0)
        assertTrue(Automations.validationError(bigDrop)!!.contains("90"))

        val bigPromo = AutomationDraft(name = "x", actionType = "set_promo_rate_pct", actionPct = 150.0)
        assertTrue(Automations.validationError(bigPromo)!!.contains("100"))

        assertNull(Automations.validationError(AutomationDraft(name = "x", actionPct = 10.0)))
    }

    @Test
    fun `ending a listing needs no percentage`() {
        val draft = AutomationDraft(name = "Clear out", actionType = "end_listing", actionPct = 0.0)
        assertTrue(Automations.isValid(draft))
    }

    // ── what gets sent ───────────────────────────────────────────────────────

    @Test
    fun `watchers ride only on the trigger that uses them`() {
        // A 0 on the other triggers would read as a threshold nobody set.
        assertNull(Automations.trigger(AutomationDraft(triggerType = "days_listed_gt")).watchers)
        assertEquals(
            2,
            Automations.trigger(
                AutomationDraft(triggerType = "watchers_lt_after_days", triggerWatchers = 2),
            ).watchers,
        )
    }

    @Test
    fun `days and cooldown never go below one`() {
        val trigger = Automations.trigger(
            AutomationDraft(triggerDays = 0, cooldownDays = 0),
        )
        assertEquals(1, trigger.days)
        assertEquals(1, trigger.cooldownDays)
    }

    @Test
    fun `an end-listing action carries no price fields`() {
        val action = Automations.action(AutomationDraft(actionType = "end_listing", actionPct = 10.0))
        assertNull(action.pct)
        assertNull(action.marginFloorPct)
    }

    @Test
    fun `a margin floor rides only on a price drop`() {
        assertEquals(15, Automations.action(AutomationDraft(marginFloorPct = 15)).marginFloorPct)
        assertNull(
            Automations.action(
                AutomationDraft(actionType = "set_promo_rate_pct", marginFloorPct = 15),
            ).marginFloorPct,
        )
    }

    // ── the scope trap ───────────────────────────────────────────────────────

    @Test
    fun `an incomplete filter clause is dropped, not sent as a match-everything`() {
        val draft = AutomationDraft(
            name = "x",
            scopeMode = "filter",
            scopeRules = listOf(
                ScopeRuleDraft("brand", "eq", "Nike"),
                ScopeRuleDraft("size", "eq", "   "),
            ),
        )
        val scope = Automations.scope(draft)
        assertEquals("filter", scope.type)
        assertEquals(listOf("brand"), scope.rules!!.map { it.field })
    }

    @Test
    fun `a value-less operator keeps its clause`() {
        // "is empty" has nothing to compare to; dropping it would widen the rule.
        val draft = AutomationDraft(
            name = "x",
            scopeMode = "filter",
            scopeRules = listOf(ScopeRuleDraft("brand", "isnull", "")),
        )
        assertEquals(1, Automations.scope(draft).rules!!.size)
    }

    @Test
    fun `a filter with nothing left in it becomes all listings, loudly`() {
        // The most dangerous silent widening this screen can produce, so the
        // editor gets a flag it can show BEFORE saving.
        val draft = AutomationDraft(
            name = "x",
            scopeMode = "filter",
            scopeRules = listOf(ScopeRuleDraft("brand", "eq", "")),
        )
        assertEquals("all", Automations.scope(draft).type)
        assertTrue(Automations.scopeSilentlyWidened(draft))
        assertFalse(Automations.scopeSilentlyWidened(AutomationDraft(name = "x", scopeMode = "all")))
    }

    // ── previews and reports ─────────────────────────────────────────────────

    @Test
    fun `a dry run says how much it would touch`() {
        assertEquals(
            "No active listings to check.",
            Automations.dryRunSummary(AutomationDryRunResult(0, emptyList())),
        )
        assertEquals(
            "Checked 40. Nothing matches yet.",
            Automations.dryRunSummary(AutomationDryRunResult(40, emptyList())),
        )
        assertEquals(
            "Would change 3 of 40.",
            Automations.dryRunSummary(
                AutomationDryRunResult(40, List(3) { AutomationDryRunMatch(listingId = "l$it") }),
            ),
        )
    }

    @Test
    fun `a floored price drop says it did less than asked`() {
        val match = AutomationDryRunMatch(
            listingId = "l1",
            currentPriceCents = 4800,
            newPriceCents = 4400,
            floored = true,
        )
        assertTrue(Automations.matchSummary(match).contains("margin floor"))
    }

    @Test
    fun `a change that never reached eBay is surfaced`() {
        // The listing a buyer sees still shows the old value.
        val rows = listOf(
            AutomationActionRow(id = "a1", ebaySynced = true),
            AutomationActionRow(id = "a2", ebaySynced = false),
        )
        assertTrue(Automations.unsyncedWarning(rows)!!.contains("1 change"))
        assertNull(Automations.unsyncedWarning(rows.take(1)))
    }

    @Test
    fun `a skipped run reports the server's reason`() {
        assertEquals(
            "Skipped: automations are turned off",
            Automations.runSummary(
                AutomationRunResult(ok = false, skipped = true, reason = "automations are turned off"),
            ),
        )
    }

    // ── AC2: locale-aware display ────────────────────────────────────────────

    @Test
    fun `money follows the device locale rather than a hardcoded dollar sign`() {
        val us = Automations.money(4800, Locale.US)
        val de = Automations.money(4800, Locale.GERMANY)
        assertTrue("US was $us", us.contains("48.00"))
        // Same amount, different separators/symbol placement — which is the
        // whole point of routing through the shared formatter.
        assertTrue("DE was $de", de.contains("48,00"))
    }

    @Test
    fun `whole percents lose the pointless decimal`() {
        assertEquals("10", Automations.formatPct(10.0))
        assertEquals("7.5", Automations.formatPct(7.5))
    }
}
