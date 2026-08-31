package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.R
import com.gradethread.app.automations.AutomationAction
import com.gradethread.app.automations.AutomationDraft
import com.gradethread.app.automations.AutomationDryRunMatch
import com.gradethread.app.automations.AutomationDryRunResult
import com.gradethread.app.automations.AutomationRule
import com.gradethread.app.automations.AutomationScope
import com.gradethread.app.automations.AutomationScopeRule
import com.gradethread.app.automations.AutomationTrigger
import com.gradethread.app.automations.AutomationsActions
import com.gradethread.app.automations.AutomationsContent
import com.gradethread.app.automations.AutomationsViewModel
import com.gradethread.app.ui.theme.GradeThreadTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * US-2902 AC3: goldens over rules the SERVER runs while nobody is watching.
 *
 * ⚠ THE DRY RUN IS THE ONLY LOOK BEFORE THE LEAP, and it is a dialog, so
 * nothing but a capture can check it. These rules run on the server on their
 * own schedule - the screen says so in its own subtitle - which means a seller
 * cannot watch one work and cannot undo what it did. "What this rule would do"
 * is the whole safety story.
 *
 * ⚠ AND IT MUST NEVER TRUNCATE SILENTLY. Twenty matches are listed and the
 * remainder is counted in a line saying how many were hidden. A dry run showing
 * twenty of two hundred without saying so is worse than none: it reads as a
 * small, safe rule. The fixture therefore carries TWENTY-THREE matches, so the
 * golden has to render that line or the claim is untested.
 *
 * ⚠ AN INACTIVE RULE IS NOT A DELETED ONE. One fixture rule is switched off,
 * because "Run all rules now" is enabled only when at least one is active, and
 * an off rule that looked identical to an on one would make that button's
 * greying look arbitrary.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class AutomationsScreenshotTest {

    private val activeRule = AutomationRule(
        id = "a1",
        name = "Drop slow Patagonia 10%",
        trigger = AutomationTrigger(type = "days_listed_gt", days = 30, cooldownDays = 7),
        action = AutomationAction(type = "price_drop_pct", pct = 10.0, marginFloorPct = 15),
        // US-2976: `filter`, not `rules`. Nothing produces or reads `rules`, so
        // scopeSummary fell through to "All active listings" and the golden
        // showed a Patagonia-only rule claiming it touched the whole shop.
        scope = AutomationScope(
            type = "filter",
            combinator = "and",
            rules = listOf(AutomationScopeRule(field = "brand", op = "eq", value = "Patagonia")),
        ),
        isActive = true,
        lastRunAt = "2026-08-28T03:00:00Z",
    )

    /**
     * Switched off. Still listed, and visibly different from the one above.
     *
     * US-2976: the trigger and action types are the WIRE values now. They read
     * `watchers_gt` and `promo_rate_pct`, which no server sends and no branch
     * matches, so the golden showed this promo rule described as a price drop.
     */
    private val pausedRule = AutomationRule(
        id = "a2",
        name = "Promote anything with watchers",
        trigger = AutomationTrigger(
            type = "watchers_lt_after_days",
            days = 14,
            cooldownDays = 14,
            watchers = 3,
        ),
        action = AutomationAction(type = "set_promo_rate_pct", pct = 4.0),
        scope = AutomationScope(type = "all"),
        isActive = false,
    )

    private val loaded = AutomationsViewModel.State(
        loading = false,
        rules = listOf(activeRule, pausedRule),
    )

    @Test
    fun rules_light() = capture("screen-automations-light") {
        AutomationsContent(loaded, AutomationsActions())
    }

    @Test
    fun rules_dark() = capture("screen-automations-dark", dark = true) {
        AutomationsContent(loaded, AutomationsActions())
    }

    /** Nothing set up yet. Reads as "not started", not as a failure. */
    @Test
    fun noRules_light() = capture("screen-automations-empty-light") {
        AutomationsContent(
            AutomationsViewModel.State(loading = false),
            AutomationsActions(),
        )
    }

    /**
     * The dry run, with more matches than it lists. The "and N more" line is
     * the assertion: 23 matches, 20 shown.
     */
    @Test
    fun dryRunTruncated_light() = capture("screen-automations-dryrun-light") {
        AutomationsContent(
            loaded.copy(
                dryRunFor = "a1",
                dryRun = AutomationDryRunResult(
                    listingsScanned = 184,
                    affected = List(23) { i ->
                        AutomationDryRunMatch(
                            listingId = "l$i",
                            title = "Patagonia item ${i + 1}",
                            actionType = "price_drop_pct",
                            currentPriceCents = 12_800 - i * 100,
                            newPriceCents = 11_520 - i * 90,
                        )
                    },
                ),
            ),
            AutomationsActions(),
        )
    }

    /** A dry run that matched nothing. The rule is on, and it would do nothing. */
    @Test
    fun dryRunNoMatches_dark() = capture("screen-automations-dryrun-empty-dark", dark = true) {
        AutomationsContent(
            loaded.copy(
                dryRunFor = "a2",
                dryRun = AutomationDryRunResult(listingsScanned = 184, affected = emptyList()),
            ),
            AutomationsActions(),
        )
    }

    /** The delete dialog, and its promise that changes already made stay made. */
    @Test
    fun deleteDialog_dark() = capture("screen-automations-delete-dark", dark = true) {
        AutomationsContent(loaded, AutomationsActions(), deleting = activeRule)
    }

    /** The editor, open on the active rule. */
    @Test
    fun editor_light() = capture("screen-automations-editor-light") {
        AutomationsContent(
            loaded,
            AutomationsActions(),
            editing = AutomationDraft.from(activeRule),
        )
    }

    /**
     * A warning beside a success, which are different tones for a reason.
     *
     * US-2976: both are now the sentences the app actually produces. The old
     * fixture said "Ran 2 rules and changed 6 listings." and "1 rule was
     * skipped: it is still inside its cooldown." - neither of which any code
     * path here has ever generated, so the golden was pinning the layout
     * against wording nobody would ever see.
     */
    @Test
    fun bannerAndWarning_light() = capture("screen-automations-banner-light") {
        AutomationsContent(
            loaded.copy(
                banner = UiMessage(R.string.automation_run_changed, args = listOf(6, 40)),
                unsyncedCount = 2,
            ),
            AutomationsActions(),
        )
    }

    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            GradeThreadTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}
