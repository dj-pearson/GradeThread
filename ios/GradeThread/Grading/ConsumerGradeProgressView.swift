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

            case .needsCredits(_, let offer):
                notice(
                    title: "You are out of grades",
                    // PackOffer carries credits + priceCents and no display
                    // label; naming the size is the honest version, and it is
                    // the number the route itself chose.
                    body: offer.map { "A \($0.credits)-grade pack covers this one." }
                        ?? "Top up to grade this garment.",
                    charged: false
                )

            case .awaitingCredits:
                // NOT a spinner with no explanation: the purchase completed on
                // the device and the balance moves server-side, so a person who
                // just paid is looking at a screen that owes them a sentence.
                busy("Purchase received, adding your grades")

            case .creditsDelayed:
                notice(
                    title: "Your grades are taking a moment",
                    body: "The purchase went through. This usually lands within a minute.",
                    charged: false
                )

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
