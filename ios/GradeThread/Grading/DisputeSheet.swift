import SwiftUI

/// Lets a reseller dispute a certified grade they believe is wrong. Inserts
/// a `disputes` row (RLS-scoped to the owner) the same way the web does —
/// admins review it in the existing dispute queue.
struct DisputeSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AuthStore.self) private var authStore

    let gradeReportId: String

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
                    form
                case .done:
                    doneState
                case let .failed(message):
                    form.overlay(alignment: .bottom) {
                        Text(message)
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .padding()
                    }
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

    private var form: some View {
        Form {
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
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
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
        guard canSubmit, let userId = currentUserId else {
            phase = .failed("You need to be signed in to file a dispute.")
            return
        }
        phase = .submitting
        let composed = DisputeComposer.compose(reason: reason, details: details)
        struct DisputeInsert: Encodable {
            let grade_report_id: String
            let user_id: String
            let reason: String
        }
        do {
            try await SupabaseShared.client
                .from("disputes")
                .insert(DisputeInsert(grade_report_id: gradeReportId, user_id: userId, reason: composed))
                .execute()
            Telemetry.event("grade.dispute_filed", props: ["reason": reason.rawValue])
            HapticFeedback.success()
            phase = .done
        } catch {
            HapticFeedback.error()
            phase = .failed(error.localizedDescription)
        }
    }
}
