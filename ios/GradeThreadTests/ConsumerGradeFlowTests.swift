import XCTest
@testable import GradeThread

/// US-2016. The consumer grade journey, driven through injected seams so every
/// branch runs without a network.
///
/// THE TWO CASES THIS FILE EXISTS FOR are the ones a careless `catch` turns
/// into a red banner: running out of credits, and the quality gate abstaining.
/// Neither is a failure. Nothing is charged in either, one is an offer and the
/// other is a retake, and both are the ordinary path for a real customer.
@MainActor
final class ConsumerGradeFlowTests: XCTestCase {

    private let request = PhotoGradeRequest(
        garmentType: "jacket",
        garmentCategory: "outerwear",
        title: "Denim jacket",
        tier: "standard",
        brand: nil,
        description: nil,
        inventoryItemId: nil,
        closetItemId: nil
    )

    private var images: [PhotoGradeImage] {
        [
            PhotoGradeImage(gradingType: "front", jpeg: Data([0xFF])),
            PhotoGradeImage(gradingType: "back", jpeg: Data([0xFF])),
            PhotoGradeImage(gradingType: "label", jpeg: Data([0xFF])),
        ]
    }

    private func status(
        _ value: String,
        feedback: PhotoGradeStatus.QualityFeedback? = nil
    ) -> PhotoGradeStatus {
        PhotoGradeStatus(
            id: "sub-1", status: value, payment_status: nil, quality_feedback: feedback)
    }

    // MARK: - Happy paths

    func testAlreadyPaidGoesStraightToPolling() async {
        // The submit reply carries paid:true when an included grade covered it,
        // so charging again would be a second call that can only fail.
        var payCalls = 0
        let flow = ConsumerGradeFlow(
            submit: { _, _, _ in .submitted(submissionId: "sub-1", paid: true) },
            pay: { _ in payCalls += 1; return .paidFromIncluded(used: 1) },
            status: { _ in self.status("completed") },
            sleep: { _ in }
        )
        await flow.start(images: images, request: request)
        XCTAssertEqual(flow.step, .graded(submissionId: "sub-1"))
        XCTAssertEqual(payCalls, 0, "an already-paid submission must not be charged again")
    }

    func testUnpaidSubmissionIsChargedThenPolled() async {
        let flow = ConsumerGradeFlow(
            submit: { _, _, _ in .submitted(submissionId: "sub-1", paid: false) },
            pay: { _ in .paidFromCredits(balance: 4) },
            status: { _ in self.status("completed") },
            sleep: { _ in }
        )
        await flow.start(images: images, request: request)
        XCTAssertEqual(flow.step, .graded(submissionId: "sub-1"))
    }

    // MARK: - The two no-charge states

    func testOutOfCreditsIsAnOfferAndNotAFailure() async {
        let offer = PhotoGradePayment.PackOffer(credits: 25, priceCents: 5999)
        let flow = ConsumerGradeFlow(
            submit: { _, _, _ in .submitted(submissionId: "sub-1", paid: false) },
            pay: { _ in .needsCredits(offer: offer) },
            status: { _ in self.status("completed") },
            sleep: { _ in }
        )
        await flow.start(images: images, request: request)
        XCTAssertEqual(flow.step, .needsCredits(submissionId: "sub-1", offer: offer))
        // Not .failed. A red banner here greets a customer who is about to buy
        // something with an error message.
        if case .failed = flow.step { XCTFail("out of credits is not a failure") }
    }

    func testAbstainIsAnAskAndNotAFailure() async {
        let feedback = PhotoGradeStatus.QualityFeedback(
            summary: "The tag photo is too blurry to read.",
            photo_requests: ["Retake the tag shot in better light."],
            issues: [
                .init(image_type: "label", problem: "blur", severity: "block", message: "blurry"),
                // A warn must NOT reach the retake list: it did not stop the
                // grade, and listing it tells someone to redo a good photo.
                .init(image_type: "detail", problem: "framing", severity: "warn", message: "tight"),
            ]
        )
        let flow = ConsumerGradeFlow(
            submit: { _, _, _ in .submitted(submissionId: "sub-1", paid: true) },
            pay: { _ in .paidFromIncluded(used: 1) },
            status: { _ in self.status("needs_photos", feedback: feedback) },
            sleep: { _ in }
        )
        await flow.start(images: images, request: request)
        guard case let .needsPhotos(id, messages, slots) = flow.step else {
            return XCTFail("expected needsPhotos, got \(flow.step)")
        }
        XCTAssertEqual(id, "sub-1")
        // The SERVER's sentence, not one built here from the issues.
        XCTAssertEqual(messages, ["Retake the tag shot in better light."])
        // The seller's word for the slot, and only the blocking one.
        XCTAssertEqual(slots, ["tag"])
    }

    func testRetryPaymentAfterBuyingCreditsProceeds() async {
        // Safe by construction: the route enforces one debit per submission
        // (US-2298), so a second pay call cannot double-charge.
        var attempt = 0
        let flow = ConsumerGradeFlow(
            submit: { _, _, _ in .submitted(submissionId: "sub-1", paid: false) },
            pay: { _ in
                attempt += 1
                return attempt == 1
                    ? .needsCredits(offer: nil)
                    : .paidFromCredits(balance: 24)
            },
            status: { _ in self.status("completed") },
            sleep: { _ in }
        )
        await flow.start(images: images, request: request)
        XCTAssertEqual(flow.step, .needsCredits(submissionId: "sub-1", offer: nil))
        await flow.retryPayment(submissionId: "sub-1")
        XCTAssertEqual(flow.step, .graded(submissionId: "sub-1"))
    }

    // MARK: - Polling

    func testATransientStatusFailureKeepsPolling() async {
        // The grade is running server-side either way. Telling the user their
        // submission died because one poll timed out would be wrong.
        var calls = 0
        let flow = ConsumerGradeFlow(
            submit: { _, _, _ in .submitted(submissionId: "sub-1", paid: true) },
            pay: { _ in .paidFromIncluded(used: 1) },
            status: { _ in
                calls += 1
                if calls == 1 { throw EdgeAPIError.network("offline") }
                return self.status("completed")
            },
            sleep: { _ in }
        )
        await flow.start(images: images, request: request)
        XCTAssertEqual(flow.step, .graded(submissionId: "sub-1"))
        XCTAssertEqual(calls, 2)
    }

    func testPendingReviewKeepsPolling() async {
        // A sub-0.75 grade goes to a human and DOES move afterwards, so
        // treating it as terminal parks the user on a finished-looking screen.
        var calls = 0
        let flow = ConsumerGradeFlow(
            submit: { _, _, _ in .submitted(submissionId: "sub-1", paid: true) },
            pay: { _ in .paidFromIncluded(used: 1) },
            status: { _ in
                calls += 1
                return calls < 3 ? self.status("pending_review") : self.status("completed")
            },
            sleep: { _ in }
        )
        await flow.start(images: images, request: request)
        XCTAssertEqual(flow.step, .graded(submissionId: "sub-1"))
        XCTAssertEqual(calls, 3)
    }

    func testATerminalNonGradeIsNamedRatherThanGeneric() async {
        let flow = ConsumerGradeFlow(
            submit: { _, _, _ in .submitted(submissionId: "sub-1", paid: true) },
            pay: { _ in .paidFromIncluded(used: 1) },
            status: { _ in self.status("expired") },
            sleep: { _ in }
        )
        await flow.start(images: images, request: request)
        guard case let .failed(message) = flow.step else {
            return XCTFail("expected failed, got \(flow.step)")
        }
        // Each terminal status has a different next move, so "something went
        // wrong" would be the least useful true thing to say.
        XCTAssertTrue(message.contains("expired"), message)
    }

    // MARK: - Upload progress

    func testProgressNeverGoesBackwards() async {
        // A retried body segment can report a LOWER cumulative count, and a bar
        // that jumps back reads as a failure. The step is sampled from inside
        // the submit seam, which is the only point where the uploading phase is
        // still live - by the time start() returns it has moved on.
        var samples: [Double] = []
        var flowRef: ConsumerGradeFlow?
        let flow = ConsumerGradeFlow(
            submit: { _, _, onProgress in
                for fraction in [0.4, 0.2, 0.9] {
                    onProgress(fraction)
                    if case let .uploading(current) = flowRef?.step {
                        samples.append(current)
                    }
                }
                return .submitted(submissionId: "sub-1", paid: true)
            },
            pay: { _ in .paidFromIncluded(used: 1) },
            status: { _ in self.status("completed") },
            sleep: { _ in }
        )
        flowRef = flow
        await flow.start(images: images, request: request)
        XCTAssertEqual(samples, [0.4, 0.4, 0.9], "the 0.2 must not move the bar back")
        XCTAssertEqual(flow.step, .graded(submissionId: "sub-1"))
    }

    // MARK: - Refusals before the upload

    func testAMissingRequiredShotIsRefusedBeforeUploading() {
        // The route would charge, run a vision call per image, abstain and
        // refund - the money comes back and the AI spend does not (US-2304).
        let missingTag = [
            PhotoGradeImage(gradingType: "front", jpeg: Data([0xFF])),
            PhotoGradeImage(gradingType: "back", jpeg: Data([0xFF])),
        ]
        XCTAssertEqual(
            PhotoGradeFields.validate(missingTag),
            .missingRequired(["label"])
        )
    }

    func testTheRefusalNamesTheSlotInTheSeller_sWords() {
        let error = PhotoGradeError.missingRequired(["label"])
        // "Add the label photo" sends someone looking for a control that does
        // not exist on the capture strip.
        XCTAssertTrue(error.errorDescription?.contains("tag") == true)
        XCTAssertFalse(error.errorDescription?.contains("label") == true)
    }
}
