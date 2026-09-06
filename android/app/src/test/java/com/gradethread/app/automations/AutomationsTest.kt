package com.gradethread.app.automations

import com.gradethread.app.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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

    // US-2976: these assert the resource and its NUMBERS, not the built
    // sentence. Which condition a trigger describes, and which numbers land in
    // it, is the whole risk - and both survive the move to strings.xml. What
    // does not survive is the word order, which is a fact about English.

    @Test
    fun `each trigger reads as the condition it actually checks`() {
        val listed = Automations.triggerSummary(AutomationTrigger("days_listed_gt", 30, 7))
        assertEquals(R.plurals.automation_trigger_summary_days_listed, listed.res)
        assertEquals(30, listed.quantity)
        assertEquals(listOf<Any>(30), listed.args)

        val views = Automations.triggerSummary(AutomationTrigger("no_views_in_days", 14, 7))
        assertEquals(R.plurals.automation_trigger_summary_no_views, views.res)
        assertEquals(14, views.quantity)
        assertEquals(listOf<Any>(14), views.args)

        // Watchers first, then days: swap them and the rule reads as a
        // different rule from the one that will run.
        val watchers =
            Automations.triggerSummary(AutomationTrigger("watchers_lt_after_days", 21, 7, 2))
        assertEquals(R.string.automation_trigger_summary_watchers, watchers.res)
        assertEquals(listOf<Any>(2, 21), watchers.args)
    }

    @Test
    fun `each action reads as what it does`() {
        val drop = Automations.actionSummary(AutomationAction("price_drop_pct", 10.0, 10))
        assertEquals(R.string.automation_action_summary_drop, drop.res)
        assertEquals(listOf<Any>("10"), drop.args)

        val promo = Automations.actionSummary(AutomationAction("set_promo_rate_pct", 7.5))
        assertEquals(R.string.automation_action_summary_promo, promo.res)
        assertEquals(listOf<Any>("7.5"), promo.args)

        assertEquals(
            R.string.automation_action_summary_end,
            Automations.actionSummary(AutomationAction("end_listing")).res,
        )
    }

    @Test
    fun `the whole rule is three clauses the screen joins`() {
        val parts = Automations.sentenceParts(rule())
        assertEquals(R.plurals.automation_trigger_summary_days_listed, parts.trigger.res)
        assertEquals(R.string.automation_action_summary_drop, parts.action.res)
        assertEquals(R.string.automation_scope_all, parts.scope.res)
    }

    @Test
    fun `a filtered scope carries how many clauses it has`() {
        val filtered = Automations.scopeSummary(
            AutomationScope("filter", "and", listOf(AutomationScopeRule("brand", "eq", "Nike"))),
        )
        assertEquals(R.string.automation_scope_filtered, filtered.res)
        assertEquals(listOf<Any>(1), filtered.args)
    }

    @Test
    fun `a wire key nobody has mapped gets no label rather than a wrong one`() {
        // US-2976: label() used to fall back to the raw key. Returning null
        // hands the caller the choice, and the screen shows the key - a
        // dropdown reading `watchers_lt_after_days` is a visible bug report,
        // where quietly showing the first option would arm the wrong rule.
        assertEquals(
            R.string.automation_op_isnull,
            Automations.label(Automations.scopeOps, "isnull"),
        )
        assertNull(Automations.label(Automations.scopeOps, "regex_match"))
        assertNull(Automations.label(Automations.triggerTypes, "price_below"))
    }

    @Test
    fun `an unscoped end-listing rule is flagged before it runs`() {
        // It can take a seller's whole shop down on a timer. Legitimate to want,
        // catastrophic by accident.
        val danger = rule(action = AutomationAction("end_listing"), scope = AutomationScope("all"))
        assertEquals(R.string.automation_scope_warning, Automations.scopeWarning(danger))

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
        assertEquals(
            R.string.automation_error_name_required,
            Automations.validationError(AutomationDraft(name = " "))?.res,
        )
    }

    @Test
    fun `percentages respect the server's own ceilings`() {
        // The CEILING is what has to reach the seller, and it is an argument
        // now rather than a number baked into an English sentence.
        val bigDrop = AutomationDraft(name = "x", actionType = "price_drop_pct", actionPct = 95.0)
        val dropError = Automations.validationError(bigDrop)!!
        assertEquals(R.string.automation_error_price_drop_max, dropError.res)
        assertEquals(listOf<Any>("90"), dropError.args)

        val bigPromo = AutomationDraft(name = "x", actionType = "set_promo_rate_pct", actionPct = 150.0)
        val promoError = Automations.validationError(bigPromo)!!
        assertEquals(R.string.automation_error_promo_max, promoError.res)
        assertEquals(listOf<Any>("100"), promoError.args)

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
            R.string.automation_dryrun_none,
            Automations.dryRunSummary(AutomationDryRunResult(0, emptyList())).res,
        )

        val nothing = Automations.dryRunSummary(AutomationDryRunResult(40, emptyList()))
        assertEquals(R.string.automation_dryrun_no_matches, nothing.res)
        assertEquals(listOf<Any>(40), nothing.args)

        // Matched first, scanned second. Reversed, a rule about to touch three
        // listings reads as one about to touch forty.
        val some = Automations.dryRunSummary(
            AutomationDryRunResult(40, List(3) { AutomationDryRunMatch(listingId = "l$it") }),
        )
        assertEquals(R.string.automation_dryrun_would_change, some.res)
        assertEquals(listOf<Any>(3, 40), some.args)
    }

    @Test
    fun `a floored price drop says it did less than asked`() {
        val match = AutomationDryRunMatch(
            listingId = "l1",
            currentPriceCents = 4800,
            newPriceCents = 4400,
            floored = true,
        )
        assertEquals(R.string.automation_match_price_floored, Automations.matchSummary(match).res)
        // Unfloored is a DIFFERENT resource, so the reassurance cannot be
        // printed on a drop that was not actually capped.
        assertEquals(
            R.string.automation_match_price,
            Automations.matchSummary(match.copy(floored = false)).res,
        )
    }

    @Test
    fun `a change that never reached eBay is surfaced`() {
        // The listing a buyer sees still shows the old value.
        val rows = listOf(
            AutomationActionRow(id = "a1", ebaySynced = true),
            AutomationActionRow(id = "a2", ebaySynced = false),
        )
        assertEquals(1, Automations.unsyncedCount(rows))
        assertNull(Automations.unsyncedCount(rows.take(1)))
    }

    @Test
    fun `a skipped run reports the server's reason`() {
        val skipped = Automations.runSummary(
            AutomationRunResult(ok = false, skipped = true, reason = "automations are turned off"),
        )
        assertEquals(R.string.automation_run_skipped_reason, skipped.res)
        assertEquals(listOf<Any>("automations are turned off"), skipped.args)

        // No reason is not a blank reason: a shorter sentence, not "Skipped: ".
        assertEquals(
            R.string.automation_run_skipped,
            Automations.runSummary(AutomationRunResult(ok = false, skipped = true, reason = " ")).res,
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
