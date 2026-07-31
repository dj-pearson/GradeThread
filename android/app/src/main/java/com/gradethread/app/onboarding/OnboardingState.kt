package com.gradethread.app.onboarding

import com.gradethread.app.R

/**
 * US-1384 (iOS `OnboardingUseCase`, US-747): what the new seller says they came
 * here to do, and where that drops them first.
 *
 * A first action beats a dashboard. Someone who just signed up has nothing to
 * look at yet, so landing them on empty charts teaches them the app is empty.
 */
enum class OnboardingUseCase(
    val wire: String,
    val title: String,
    val subtitle: String,
    /** The nav route onboarding routes to when it finishes. */
    val firstActionRoute: String,
) {
    RESELLER(
        wire = "reseller",
        title = "I resell at volume",
        subtitle = "Batch-photograph a pile and let AI draft every listing at once.",
        firstActionRoute = "capture/autolister",
    ),
    GRADER(
        wire = "grader",
        title = "I grade and sell a few",
        subtitle = "Snap one garment, get a certified condition grade to sell with.",
        firstActionRoute = "capture/photos",
    ),
    STORE(
        wire = "store",
        title = "I run an eBay store",
        subtitle = "Connect eBay to sync listings, orders, and payouts both ways.",
        firstActionRoute = "marketplaces",
    ),
    ;

    companion object {
        fun fromWire(value: String?): OnboardingUseCase? =
            entries.firstOrNull { it.wire == value }
    }
}

/** One slide in the first-run carousel. */
data class OnboardingPage(
    val title: String,
    val body: String,
)

object Onboarding {

    /**
     * The intro, in the order the work actually happens.
     *
     * Four slides, not eight. Every extra slide is another chance to close the
     * app before seeing it do anything.
     */
    val pages: List<OnboardingPage> = listOf(
        OnboardingPage(
            title = "Your whole reselling flow",
            body = "Source, catalog, grade, list, and track sales in one place built for resellers.",
        ),
        OnboardingPage(
            title = "Snap and catalog",
            body = "Photograph a garment and AI reads the brand, size, colour, and condition " +
                "off the tag. Review, tweak, done.",
        ),
        OnboardingPage(
            title = "Certified condition grades",
            body = "A standardised 1 to 10 grade and a shareable certificate buyers trust, " +
                "so fewer orders come back.",
        ),
        OnboardingPage(
            title = "List and track profit",
            body = "Publish to eBay, sync both ways, and see what sold, what payout is coming, " +
                "and your real profit.",
        ),
    )

    /**
     * Whether to show the first-run flow.
     *
     * Only ever once, and only to someone signed in. Onboarding before sign-in
     * would ask a stranger to pick a use case and then throw the answer away at
     * the login screen.
     */
    fun shouldShow(signedIn: Boolean, completed: Boolean): Boolean = signedIn && !completed

    /** The step a given position in the flow is on. */
    enum class Step { CAROUSEL, USE_CASE, ACTIVATION }

    /**
     * Where the flow goes next.
     *
     * The carousel advances slide by slide and only then moves on, so the last
     * slide's button reads "Next" rather than silently doing something else.
     */
    fun advance(step: Step, pageIndex: Int, pageCount: Int = pages.size): Pair<Step, Int> = when (step) {
        Step.CAROUSEL ->
            if (pageIndex < pageCount - 1) Step.CAROUSEL to pageIndex + 1 else Step.USE_CASE to pageIndex
        Step.USE_CASE -> Step.ACTIVATION to pageIndex
        Step.ACTIVATION -> Step.ACTIVATION to pageIndex
    }

    /**
     * Which label the primary button shows.
     *
     * US-1393: a STRING RESOURCE ID rather than the words. The rule (which step
     * shows which label) stays pure and testable; the words move to
     * strings.xml where they can be translated.
     */
    @androidx.annotation.StringRes
    fun primaryLabel(step: Step, pageIndex: Int, pageCount: Int = pages.size): Int = when {
        step == Step.CAROUSEL && pageIndex < pageCount - 1 -> R.string.onboarding_next
        step == Step.CAROUSEL -> R.string.onboarding_get_started
        step == Step.USE_CASE -> R.string.onboarding_continue
        else -> R.string.onboarding_start_selling
    }
}
