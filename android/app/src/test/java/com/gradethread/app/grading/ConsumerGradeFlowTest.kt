package com.gradethread.app.grading

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * US-2815: the whole journey, with no network, no clock and no store.
 *
 * Every collaborator is a constructor parameter for exactly this reason. The
 * states worth testing are the ones that are NOT failures — the credits detour
 * and the abstain — because those are the two a screen most easily renders as
 * one, and a customer who reads "we couldn't grade it" as a wasted purchase
 * asks for a refund they are already owed or, worse, pays again.
 */
class ConsumerGradeFlowTest {

    private fun image(type: String) = PhotoGradeImage(type, byteArrayOf(0xFF.toByte()))
    private val images = listOf(image("front"), image("back"), image("label"))
    private val request = PhotoGradeRequest(
        garmentType = "tops",
        garmentCategory = "t-shirt",
        title = "Levis tee",
    )

    private fun flow(
        submit: suspend (List<PhotoGradeImage>, PhotoGradeRequest, (Double) -> Unit) -> PhotoSubmitResponse =
            { _, _, _ -> PhotoSubmitResponse(submissionId = "sub-1") },
        pay: suspend (String) -> PhotoGradePayment.Outcome =
            { PhotoGradePayment.Outcome.PaidFromCredits(3) },
        status: suspend (String) -> PhotoGradeStatus =
            { PhotoGradeStatus(id = it, status = "completed") },
        sleep: suspend (Long) -> Unit = {},
    ) = ConsumerGradeFlow(submit, pay, status, sleep)

    // ── the happy path ───────────────────────────────────────────────────

    @Test
    fun aPaidGradeEndsGraded() = runTest {
        val f = flow()
        f.start(images, request)
        assertEquals(ConsumerGradeFlow.Step.Graded("sub-1"), f.step.value)
    }

    @Test
    fun uploadProgressReachesTheState() = runTest {
        // Observed MID-FLIGHT: by the time start() returns the flow has moved
        // on to Graded, so asserting afterwards would prove nothing about the
        // progress bar ever having a value.
        val holder = arrayOfNulls<ConsumerGradeFlow>(1)
        var midFlight: ConsumerGradeFlow.Step? = null
        holder[0] = flow(submit = { _, _, onProgress ->
            onProgress(0.5)
            midFlight = holder[0]?.step?.value
            PhotoSubmitResponse(submissionId = "sub-1")
        })
        holder[0]?.start(images, request)
        assertEquals(ConsumerGradeFlow.Step.Uploading(0.5), midFlight)
    }

    // ── the two states that are NOT failures ─────────────────────────────

    @Test
    fun runningOutOfCreditsIsAnOfferNotAnError() = runTest {
        val offer = PhotoGradePayment.PackOffer(credits = 10, priceCents = 999)
        val f = flow(pay = { PhotoGradePayment.Outcome.NeedsCredits(offer) })
        f.start(images, request)
        val step = f.step.value
        assertTrue("out of credits became a failure", step is ConsumerGradeFlow.Step.NeedsCredits)
        assertEquals(offer, (step as ConsumerGradeFlow.Step.NeedsCredits).offer)
    }

    @Test
    fun anAbstainIsNeedsPhotos_notFailed() = runTest {
        // The gate refused and NOTHING WAS CHARGED. Rendering this as Failed is
        // the mistake: it reads as a wasted purchase.
        val f = flow(
            status = {
                PhotoGradeStatus(
                    id = it,
                    status = "needs_photos",
                    qualityFeedback = PhotoGradeStatus.QualityFeedback(
                        summary = "Too dark",
                        photoRequests = listOf("Retake the tag in better light"),
                        photoSlots = listOf("label"),
                    ),
                )
            },
        )
        f.start(images, request)
        val step = f.step.value
        assertTrue("an abstain was rendered as a failure", step is ConsumerGradeFlow.Step.NeedsPhotos)
        assertEquals(
            listOf("Retake the tag in better light"),
            (step as ConsumerGradeFlow.Step.NeedsPhotos).messages,
        )
    }

    @Test
    fun theGatesOwnWordingIsUsed_notTheSummary() = runTest {
        // photo_requests is already de-duplicated and user-facing. Falling back
        // to the summary when requests exist would build worse sentences out of
        // better data.
        val f = flow(
            status = {
                PhotoGradeStatus(
                    id = it,
                    status = "needs_photos",
                    qualityFeedback = PhotoGradeStatus.QualityFeedback(
                        summary = "generic summary",
                        photoRequests = listOf("specific ask"),
                    ),
                )
            },
        )
        f.start(images, request)
        assertEquals(
            listOf("specific ask"),
            (f.step.value as ConsumerGradeFlow.Step.NeedsPhotos).messages,
        )
    }

    @Test
    fun theSummaryIsUsedWhenThereAreNoRequests() = runTest {
        val f = flow(
            status = {
                PhotoGradeStatus(
                    id = it,
                    status = "needs_photos",
                    qualityFeedback = PhotoGradeStatus.QualityFeedback(summary = "Too dark"),
                )
            },
        )
        f.start(images, request)
        assertEquals(
            listOf("Too dark"),
            (f.step.value as ConsumerGradeFlow.Step.NeedsPhotos).messages,
        )
    }

    // ── the credits detour ───────────────────────────────────────────────

    @Test
    fun aPurchaseRetriesTheChargeAndCompletes() = runTest {
        var attempt = 0
        val f = flow(pay = {
            attempt += 1
            if (attempt == 1) {
                PhotoGradePayment.Outcome.NeedsCredits(null)
            } else {
                PhotoGradePayment.Outcome.PaidFromCredits(9)
            }
        })
        f.start(images, request)
        assertTrue(f.step.value is ConsumerGradeFlow.Step.NeedsCredits)

        f.creditsPurchased("sub-1")
        assertEquals(ConsumerGradeFlow.Step.Graded("sub-1"), f.step.value)
        assertEquals("the charge was not retried after the purchase", 2, attempt)
    }

    // ── refusals and failures ────────────────────────────────────────────

    @Test
    fun anIncompleteSetNeverUploads() = runTest {
        var uploaded = false
        val f = flow(submit = { _, _, _ -> uploaded = true; PhotoSubmitResponse("sub-1") })
        f.start(listOf(image("front")), request)
        assertTrue("an incomplete set was uploaded", !uploaded)
        assertTrue(f.step.value is ConsumerGradeFlow.Step.Failed)
    }

    @Test
    fun aMissingSubmissionIdIsNotTreatedAsSuccess() = runTest {
        // A 200 with no id would otherwise poll forever on an empty string.
        val f = flow(submit = { _, _, _ -> PhotoSubmitResponse(submissionId = null) })
        f.start(images, request)
        assertTrue(f.step.value is ConsumerGradeFlow.Step.Failed)
    }

    @Test
    fun aPollTimeoutStaysGrading_notFailed() = runTest {
        // The grade IS still running and the certificate will exist. Saying
        // "failed" would be a lie that invites a second charge.
        val f = flow(status = { PhotoGradeStatus(id = it, status = "processing") })
        f.start(images, request)
        assertTrue(
            "a slow grade was reported as a failure",
            f.step.value is ConsumerGradeFlow.Step.Grading,
        )
    }

    @Test
    fun anUploadErrorSurfacesItsMessage() = runTest {
        val f = flow(submit = { _, _, _ -> throw IllegalStateException("no signal") })
        f.start(images, request)
        assertEquals(
            ConsumerGradeFlow.Step.Failed("no signal"),
            f.step.value,
        )
    }
}
