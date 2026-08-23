import SwiftUI

/// US-2815: the non-`ready` half of ``ConsumerGradeFlow``, rendered.
///
/// Split from ``ConsumerGradeView`` because the picking screen and the
/// after-you-press-go screen share nothing but the flow object, and because
/// every state below has a rule attached that is easy to lose in a big switch.
///
/// THE MONEY PART GOES FIRST IN THE STATES THAT ARE NOT CHARGES. The flow's own
/// header says why, and the walk-around screen learned it first: "we couldn't
/// grade it" reads like a wasted purchase until you know it was not one. An
/// abstain and a credits prompt are both no-charge states and both are commonly
/// read as failures.
struct ConsumerGradeProgressView: View {
    let step: ConsumerGradeFlow.Step
    var onDone: (String) -> Void = { _ in }

    /// US-2830: whose credits to buy. Nil only when the session expired
    /// between opening this screen and running out of grades, which is the
    /// case `SessionExpiredView` exists for elsewhere in this flow.
    var userId: UUID?
    /// A pack purchase completed. Call `creditsPurchased` — the SERVER
    /// decides whether the submission is paid.
    var onPurchased: (String) -> Void = { _ in }
    /// The "check again" behind `creditsDelayed`.
    var onRecheck: (String) -> Void = { _ in }

    /// The submission the pack sheet is open for, or nil.
    ///
    /// ONE SHEET SLOT, and it lives HERE rather than in
    /// ``ConsumerGradeView`` because that view already spends its own on
    /// the camera-or-library picker. Two `.sheet` modifiers on one view
    /// compete and the loser opens and closes in the same frame;
    /// `ios/Scripts/check-chained-sheets.py` exists because twelve views in
    /// this app were doing exactly that.
    @State private var buyingFor: String?

    var body: some View {
        VStack(spacing: 16) {
            switch step {
            case .ready:
                EmptyView()

            case .uploading(let fraction):
                // Determinate: this is the one phase with a real number.
                ProgressView(value: fraction) {
                    Text("Uploading photos")
                }
                .progressViewStyle(.linear)

            case .paying:
                busy("Checking your grades")

            case .needsCredits(let submissionId, let offer):
                notice(
                    title: "You are out of grades",
                    // PackOffer carries credits + priceCents and no display
                    // label; naming the size is the honest version, and it is
                    // the number the route itself chose.
                    body: offer.map { "A \($0.credits)-grade pack covers this one." }
                        ?? "Top up to grade this garment.",
                    charged: false
                )
                // US-2830: a price and a way to pay it. This state used to be
                // the notice alone — a pack size quoted with no control of any
                // kind, after the seller had already picked a garment, filled
                // in its details, taken every photo and waited out an upload.
                Button("Buy grades") { buyingFor = submissionId }
                    .buttonStyle(.borderedProminent)

            case .awaitingCredits:
                // NOT a spinner with no explanation: the purchase completed on
                // the device and the balance moves server-side, so a person who
                // just paid is looking at a screen that owes them a sentence.
                busy("Purchase received, adding your grades")

            case .creditsDelayed(let submissionId):
                notice(
                    title: "Your grades are taking a moment",
                    body: "The purchase went through. This usually lands within a minute.",
                    charged: false
                )
                // The copy says to wait; until now nothing let anyone look
                // again. A grant that missed the poll window is not a refusal
                // and may already have landed.
                Button("Check again") { onRecheck(submissionId) }

            case .grading(_, let statusText):
                // Indeterminate on purpose: the server sends nothing until it is
                // finished, so a percentage here would be invented.
                busy(statusText.isEmpty ? "Grading" : statusText)

            case .needsPhotos(_, let messages, _):
                notice(
                    title: "We need a clearer set",
                    body: messages.first ?? "Retake the flagged shots and try again.",
                    charged: false
                )

            case .graded(let submissionId):
                VStack(spacing: 12) {
                    Image(systemName: "checkmark.seal.fill")
                        .font(.largeTitle)
                        .foregroundStyle(.green)
                    Text("Graded")
                        .font(.headline)
                    Button("See the grade") { onDone(submissionId) }
                        .buttonStyle(.borderedProminent)
                }

            case .failed(let message):
                notice(title: "That did not go through", body: message, charged: false)
            }
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // The ONLY sheet on this view — see `buyingFor`. `CreditPackSheet` is
        // already generic: it takes a user id and a callback, and knows nothing
        // about inventory items, which is what makes reusing the FlipDesk
        // purchase surface here a mount rather than a refactor.
        .sheet(
            isPresented: Binding(
                get: { buyingFor != nil },
                set: { if !$0 { buyingFor = nil } }
            )
        ) {
            if let userId, let submissionId = buyingFor {
                CreditPackSheet(userId: userId) {
                    buyingFor = nil
                    onPurchased(submissionId)
                }
            } else {
                // US-1522: the session expired between opening this screen and
                // running out of grades. A re-sign-in prompt, not a blank sheet.
                SessionExpiredView { buyingFor = nil }
            }
        }
    }

    private func busy(_ label: String) -> some View {
        VStack(spacing: 12) {
            ProgressView()
            Text(label)
                .foregroundStyle(.secondary)
        }
    }

    /// `charged` exists so the no-charge line is a parameter rather than a habit.
    /// Every caller above passes false today, and a future state that DOES
    /// follow a charge has to say so deliberately instead of inheriting silence.
    private func notice(title: String, body: String, charged: Bool) -> some View {
        VStack(spacing: 8) {
            Text(title)
                .font(.headline)
            Text(body)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            if !charged {
                Text("You have not been charged.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
