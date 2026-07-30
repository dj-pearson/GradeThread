package com.gradethread.app.marketplaces.publish

/**
 * US-1352: where the publish flow is, as a value.
 *
 * validating → review(blockers | summary) → pushing → published | failed,
 * mirroring the iOS PublishDialog state machine. Modelled as a sealed type so
 * an impossible state (blockers AND a success URL) cannot be represented, and
 * so the transitions are unit-tested without a view.
 */
sealed interface PublishPhase {
    /** Composing. Nothing has been sent yet. */
    data object Composing : PublishPhase

    data object Validating : PublishPhase

    /**
     * Pre-flight came back. [blockers] empty means publishable; non-empty means
     * the button stays off and each line names its own fix.
     */
    data class Review(
        val summary: PublishSummary?,
        val blockers: List<String> = emptyList(),
        val warnings: List<String> = emptyList(),
    ) : PublishPhase {
        val publishable: Boolean get() = blockers.isEmpty()
    }

    data object Pushing : PublishPhase

    /** Live on eBay. Carries the listing id / URL / offer id for the item. */
    data class Published(val result: PushResponse) : PublishPhase

    /** A plan or capacity wall — an upgrade route, not a retry. */
    data class PlanLimit(val message: String) : PublishPhase

    data class Failed(val message: String) : PublishPhase
}

/**
 * The transition rules. Pure and total: every outcome maps to exactly one next
 * phase, so a new outcome case can't silently leave the UI spinning.
 */
object PublishFlow {

    /** Where [outcome] takes a flow that was validating. */
    fun afterValidate(outcome: PublishOutcome): PublishPhase = when (outcome) {
        is PublishOutcome.Validated -> PublishPhase.Review(
            summary = outcome.response.summary,
            blockers = outcome.response.blockers,
            warnings = outcome.response.warnings,
        )
        // A 422 during pre-flight is the SAME answer as an ok:false body — show
        // the blockers, don't call it an error.
        is PublishOutcome.Blockers -> PublishPhase.Review(
            summary = null,
            blockers = outcome.blockers,
        )

        is PublishOutcome.PlanLimit -> PublishPhase.PlanLimit(outcome.message)
        is PublishOutcome.Failed -> PublishPhase.Failed(outcome.message)
        // Neither can arise from validate; map them rather than crash.
        is PublishOutcome.NoOfferId -> PublishPhase.Failed(NO_OFFER_MESSAGE)
        is PublishOutcome.Pushed -> PublishPhase.Published(outcome.response)
    }

    /** Where [outcome] takes a flow that was pushing. */
    fun afterPush(outcome: PublishOutcome): PublishPhase = when (outcome) {
        is PublishOutcome.Pushed -> PublishPhase.Published(outcome.response)
        // Blockers on push mean something changed since pre-flight (a photo
        // deleted, a policy removed). Back to review rather than a dead error —
        // the seller can fix it and try again without reopening the composer.
        is PublishOutcome.Blockers -> PublishPhase.Review(
            summary = null,
            blockers = outcome.blockers,
        )

        is PublishOutcome.PlanLimit -> PublishPhase.PlanLimit(outcome.message)
        is PublishOutcome.NoOfferId -> PublishPhase.Failed(NO_OFFER_MESSAGE)
        is PublishOutcome.Failed -> PublishPhase.Failed(outcome.message)
        // Can't happen; a validate response arriving here is a wiring bug, and
        // showing it as review is better than pretending the push succeeded.
        is PublishOutcome.Validated -> PublishPhase.Review(
            summary = outcome.response.summary,
            blockers = outcome.response.blockers,
            warnings = outcome.response.warnings,
        )
    }

    /** Only a clean review can publish. Everything else is a no-op tap. */
    fun canPublish(phase: PublishPhase): Boolean =
        phase is PublishPhase.Review && phase.publishable

    /** True while a call is in flight — the sheet's controls are disabled. */
    fun isBusy(phase: PublishPhase): Boolean =
        phase is PublishPhase.Validating || phase is PublishPhase.Pushing

    const val NO_OFFER_MESSAGE =
        "This listing has no eBay offer to update. Publish it again to create one."
}
