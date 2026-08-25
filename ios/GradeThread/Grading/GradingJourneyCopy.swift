import Foundation

/// US-2870. What happens after you press submit, in the same words the web uses.
///
/// The web source is `src/lib/grading-journey.ts` and this is its twin. There is
/// NO TypeScript-to-Swift generator in this repo yet (US-2876 is building one),
/// so the guarantee is the same one `BuyerEntitlements.swift` relies on: a
/// Vitest parity test reads this file as text and fails on any drift. That test
/// is `src/test/grading-journey-parity.test.ts` and it runs on every push, on
/// the machine the edit is made on, rather than only on a macOS runner.
///
/// TWO THINGS TO KEEP RIGHT IF YOU EDIT THIS:
///
/// 1. The SLA is a CEILING, not an expectation. `GradeTier.turnaround` in
///    GradeFactors.swift is the guaranteed outer bound (48 / 12 / 1 hours);
///    grades actually finish in minutes. Copy that says "usually 48 hours" is
///    false and it contradicts the product's own published answers.
///
/// 2. No confidence percentage. There are two thresholds and they are easy to
///    confuse: one sets the `needs_human_review` flag, the other decides
///    whether a clean grade may skip the queue, and an operator can switch
///    skipping off entirely. The copy names the CONDITION instead, which stays
///    true whichever number is configured.
enum GradingJourneyCopy {
    // BEGIN GENERATED TABLE (parity-tested against src/lib/grading-journey.ts)

    /// What actually happens for the overwhelming majority of grades.
    static let typicalTurnaround = "Most grades come back in a few minutes."

    /// Where the answer turns up. The app never used to say we email, and we do.
    static let whereItAppears =
        "It appears on this page and in Submissions. We also email you, so you do not have to sit here."

    // Human review, in plain words.
    static let humanReviewWhat =
        "A person checks the grade unless the AI is sure and nothing about the photos looks unusual."
    static let humanReviewCost =
        "It costs nothing extra. You are never charged twice for one garment."
    static let humanReviewWait =
        "It takes longer than an automatic grade, so this one may run past a few minutes."
    static let humanReviewCertificate =
        "Your certificate goes live once it is official, and the score can move slightly."

    /// One of the four things a finished grade produces.
    struct Deliverable: Equatable {
        let title: String
        let detail: String
    }

    static let whatYouGet: [Deliverable] = [
        Deliverable(
            title: "A grade from 1.0 to 10.0",
            detail: "One number for how worn the garment is."),
        Deliverable(
            title: "Five factor scores",
            detail:
                "Fabric, stitching, looks, zips and buttons, and smell. Each one scored and explained."),
        Deliverable(
            title: "A condition report",
            detail: "Plain sentences saying what we found, including every flaw."),
        Deliverable(
            title: "A certificate you can share",
            detail:
                "Its own page with its own number. A buyer can look it up, so they do not have to take your word for it."),
    ]

    // END GENERATED TABLE

    /// The full turnaround sentence: what usually happens, then the guarantee.
    /// `tierLabel` and `ceiling` come from ``GradeTier`` so the numbers are not
    /// written twice on this side either.
    static func turnaround(tierLabel: String?, ceiling: String?) -> String {
        guard let tierLabel, let ceiling else { return typicalTurnaround }
        return "\(typicalTurnaround) Your \(tierLabel) grade is guaranteed within \(ceiling)."
    }
}
