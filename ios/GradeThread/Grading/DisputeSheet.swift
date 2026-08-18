import SwiftUI

/// Lets a reseller dispute a certified grade they believe is wrong.
///
/// US-2670: files through `POST /api/grade/dispute`, the same route web and
/// Android use. It used to INSERT into `disputes` directly through the anon
/// client, and the comment here said that was "the same way the web does" — it
/// was not, and the difference was every rule the route enforces:
///
///   • the filing window. US-2153 moved it server-side precisely because "the
///     7-day rule was only in client UI, so a slow/older report could still be
///     disputed via a direct API call". A table insert IS that call, and
///     `GradeDisputeWindow` only ever decided whether the button was enabled.
///   • ownership of the REPORT. The RLS insert policies on `disputes` check
///     `auth.uid() = user_id` and workspace membership — both on the `user_id`
///     column. Neither checks who owns `grade_report_id`, so a direct insert
///     accepted any valid report id.
///   • the duplicate refusal, the evidence-image pipeline (validate, strip EXIF,
///     store) and the submission status flip. All of it edge-side.
///
/// Android's DisputeService already did this and says why in its own header. iOS
/// was the last client inserting directly.
struct DisputeSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AuthStore.self) private var authStore

    let gradeReportId: String
    /// US-1183: invoked on a successful insert so the caller can optimistically
    /// reflect the dispute (badge + gate re-filing) without waiting for a sync.
    var onSubmitted: (() -> Void)? = nil

    @State private var reason: DisputeReason = .gradeTooLow
    @State private var details: String = ""
    @State private var phase: Phase = .editing

    private enum Phase: Equatable {
        case editing
        case submitting
        case done
        case failed(String)
    }

    private var canSubmit: Bool {
        DisputeComposer.canSubmit(reason: reason, details: details)
    }

    private var currentUserId: String? {
        if case let .signedIn(user) = authStore.phase { return user.id.uuidString }
        return nil
    }

    var body: some View {
        NavigationStack {
            Group {
                switch phase {
                case .editing, .submitting:
                    form()
                case .done:
                    doneState
                case let .failed(message):
                    // US-1183: render the error as an inline section above the
                    // submit button (see `form`), not a free-floating bottom
                    // overlay that sits on top of / overlaps the button.
                    form(errorMessage: message)
                }
            }
            .navigationTitle("Dispute grade")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(phase == .done ? "Done" : "Cancel") { dismiss() }
                }
            }
        }
        .interactiveDismissDisabled(phase == .submitting)
    }

    private func form(errorMessage: String? = nil) -> some View {
        Form {
            if let errorMessage {
                Section {
                    Label(errorMessage, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
            Section {
                Picker("Reason", selection: $reason) {
                    ForEach(DisputeReason.allCases) { reason in
                        Text(reason.label).tag(reason)
                    }
                }
                .pickerStyle(.navigationLink)
            } footer: {
                Text("Tell us what looks off. Disputes are reviewed by a human; we'll update you when there's a decision.")
                    .font(.footnote)
            }

            Section {
                TextField(
                    reason == .other ? "Explain the issue (required)" : "Add any details (optional)",
                    text: $details,
                    axis: .vertical
                )
                .lineLimit(3...8)
            } header: {
                Text("Details")
            } footer: {
                if reason == .other {
                    Text("\(details.trimmingCharacters(in: .whitespacesAndNewlines).count)/\(DisputeComposer.otherMinLength) characters minimum")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                Button {
                    AppRouter.haptic()
                    Task { await submit() }
                } label: {
                    HStack {
                        if phase == .submitting {
                            ProgressView().tint(.white)
                        } else {
                            Text("Submit dispute").font(.subheadline.weight(.semibold))
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(canSubmit ? Color.brandNavy : Color.secondary.opacity(0.4))
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
                }
                .disabled(!canSubmit || phase == .submitting)
                .listRowBackground(Color.clear)
                .listRowInsets(.init(top: 4, leading: 0, bottom: 4, trailing: 0))
            }
        }
    }

    private var doneState: some View {
        ContentUnavailableView {
            Label("Dispute submitted", systemImage: "checkmark.circle.fill")
        } description: {
            Text("Thanks — we'll review this grade and let you know the outcome.")
        } actions: {
            Button("Done") { dismiss() }
                .buttonStyle(.borderedProminent)
                .tint(Color.brandNavy)
        }
    }

    private func submit() async {
        guard canSubmit, currentUserId != nil else {
            phase = .failed("You need to be signed in to file a dispute.")
            return
        }
        phase = .submitting
        let composed = DisputeComposer.compose(reason: reason, details: details)
        // The route derives the owner from the session, so no user_id is sent —
        // a client-supplied one was never the thing being trusted anyway.
        struct DisputeRequest: Encodable {
            let gradeReportId: String
            let reason: String
        }
        struct DisputeResponse: Decodable {
            let success: Bool?
        }
        do {
            let _: DisputeResponse = try await EdgeAPI.shared.postJSON(
                "/api/grade/dispute",
                body: DisputeRequest(gradeReportId: gradeReportId, reason: composed)
            )
            Telemetry.event("grade.dispute_filed", props: ["reason": reason.rawValue])
            HapticFeedback.success()
            onSubmitted?()
            phase = .done
        } catch {
            HapticFeedback.error()
            // EdgeAPIError is a LocalizedError whose description carries the
            // server's own `error` string, so the two rejections a seller can
            // actually hit — the window has closed, a dispute already exists —
            // arrive worded by the side that owns the rule. Nothing here
            // hardcodes the window length, which is the point of US-2153.
            phase = .failed(error.localizedDescription)
        }
    }
}
