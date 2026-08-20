import PhotosUI
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
    // US-2688: evidence photos. Web and Android have sent these since US-1437;
    // the client built around a camera was the one that could not attach one.
    @State private var evidence: [DisputeEvidencePhoto] = []
    @State private var picking = false
    @State private var evidenceNote: String?

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

            evidenceSection

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

    private var evidenceRoom: Int {
        max(0, DisputeEvidence.maxPhotos - evidence.count)
    }

    /// US-2688. A condition dispute is an argument about what the garment looks
    /// like, so the photograph is the evidence rather than a nicety.
    @ViewBuilder
    private var evidenceSection: some View {
        Section {
            if !evidence.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(evidence) { photo in
                            ZStack(alignment: .topTrailing) {
                                Image(uiImage: photo.thumbnail)
                                    .resizable()
                                    .scaledToFill()
                                    .frame(width: 60, height: 60)
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                                Button {
                                    evidence.removeAll { $0.id == photo.id }
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .symbolRenderingMode(.palette)
                                        .foregroundStyle(.white, .black.opacity(0.6))
                                }
                                .disabled(phase == .submitting)
                                .accessibilityLabel("Remove photo")
                                .padding(2)
                            }
                            .accessibilityElement(children: .contain)
                            .accessibilityLabel("Evidence photo")
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
            Button {
                picking = true
            } label: {
                Label("Add photo", systemImage: "camera")
            }
            .disabled(phase == .submitting || evidenceRoom == 0)
            .accessibilityLabel("Add evidence photo")
            if let evidenceNote {
                Text(evidenceNote)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Photos")
        } footer: {
            Text("Up to \(DisputeEvidence.maxPhotos) photos of the problem. Location data is stripped before they leave your phone.")
                .font(.footnote)
        }
        .sheet(isPresented: $picking) {
            PhotoLibraryPicker(selectionLimit: evidenceRoom) { results in
                Task { await stage(results) }
            }
            .ignoresSafeArea()
        }
    }

    private func stage(_ results: [PHPickerResult]) async {
        guard !results.isEmpty else { return }
        let staged = await DisputeEvidence.photos(from: results, room: evidenceRoom)
        evidence.append(contentsOf: staged.photos)
        // Said, not swallowed: on a dispute the missing photo may be the one
        // that wins it.
        evidenceNote = staged.skipped > 0
            ? "\(staged.skipped) photo\(staged.skipped == 1 ? "" : "s") not added - the limit is \(DisputeEvidence.maxPhotos)."
            : nil
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
        struct DisputeResponse: Decodable {
            let success: Bool?
        }
        do {
            // US-2688: DisputeRequest moved to its own file with EXPLICIT
            // CodingKeys. Declared inline here with a plain `gradeReportId`, it
            // was encoded by JSONEncoder.iso8601 (.convertToSnakeCase) as
            // `grade_report_id`, and the route reads `body.gradeReportId` with
            // no fallback - so every filing from this screen answered 400
            // "gradeReportId is required" and showed the customer that string.
            let _: DisputeResponse = try await EdgeAPI.shared.postJSON(
                "/api/grade/dispute",
                body: DisputeRequest(
                    gradeReportId: gradeReportId,
                    reason: composed,
                    images: evidence.map(\.dataURL)
                )
            )
            Telemetry.event(
                "grade.dispute_filed",
                props: ["reason": reason.rawValue, "evidence": evidence.count]
            )
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
