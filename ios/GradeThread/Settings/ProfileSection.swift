import SwiftUI
import UIKit

/// Settings sections for profile (editable name), plan + grading usage, and
/// data export. Designed to be dropped into the Settings `List` alongside the
/// existing sync / notifications / analytics sections.
struct ProfileSection: View {
    @Environment(AuthStore.self) private var authStore

    @State private var store = ProfileStore()
    @State private var nameDraft: String = ""
    @State private var isSavingName = false
    // US-1205: transient "Saved" confirmation (was haptic-only — invisible with
    // haptics off / to VoiceOver).
    @State private var nameSaved = false
    @State private var isExporting = false
    @State private var errorMessage: String?
    @State private var exportFile: ExportFile?

    private var currentName: String { store.profile?.fullName ?? "" }
    private var nameChanged: Bool {
        nameDraft.trimmingCharacters(in: .whitespacesAndNewlines) != currentName
    }

    var body: some View {
        Group {
            profileSection
            verifiedSection
            teamSection
            inviteSection
            planSection
            dataSection
        }
        .task {
            await store.refresh()
            nameDraft = store.profile?.fullName ?? ""
        }
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
        .sheet(item: $exportFile) { file in
            // US-694: drop the protected account-export file once shared.
            ShareSheet(items: [file.url]) { SecureTempFile.delete(file.url) }
        }
    }

    // MARK: - Sections

    private var profileSection: some View {
        Section("Profile") {
            TextField("Name", text: $nameDraft)
                .textInputAutocapitalization(.words)
            Button {
                Task { await saveName() }
            } label: {
                HStack {
                    Text("Save name")
                    if isSavingName {
                        Spacer()
                        ProgressView()
                    } else if nameSaved {
                        Spacer()
                        Label("Saved", systemImage: "checkmark.circle.fill")
                            .labelStyle(.titleAndIcon)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color.brandEmerald)
                            .transition(.opacity)
                    }
                }
            }
            .disabled(isSavingName || !nameChanged)
        }
    }

    private var verifiedSection: some View {
        Section {
            NavigationLink {
                VerifiedView()
            } label: {
                Label("Verified seller", systemImage: "checkmark.seal")
            }
        } footer: {
            Text("Claim your public profile — buyers can see your verified grades and stats.")
                .font(.footnote)
        }
    }

    private var selfUserId: String? {
        if case let .signedIn(user) = authStore.phase { return user.id.uuidString }
        return nil
    }

    @ViewBuilder
    private var teamSection: some View {
        if let selfUserId {
            Section {
                NavigationLink {
                    // US-1254: scope to the ACTIVE workspace (which may be a
                    // shared one), not always the signed-in user's own team.
                    TeamView(
                        ownerId: WorkspaceScope.tenantOwnerId(selfId: selfUserId),
                        selfId: selfUserId
                    )
                } label: {
                    Label("Team", systemImage: "person.2")
                }
            } footer: {
                Text("Invite teammates to your workspace and manage their access.")
                    .font(.footnote)
            }
        }
    }

    private var inviteSection: some View {
        Section {
            NavigationLink {
                ReferralsView()
            } label: {
                Label("Invite friends", systemImage: "gift")
            }
        } footer: {
            Text("Share your code — you both earn a reward when a friend grades their first item.")
                .font(.footnote)
        }
    }

    private var planSection: some View {
        // US-1205: this is the GRADING plan/usage; the FlipDesk PlanSection shows
        // the reseller plan. Label it distinctly so the two "Plan" rows in
        // Settings don't read as contradictory.
        Section("Grading & usage") {
            switch store.phase {
            case .loading:
                HStack {
                    Text("Grading plan")
                    Spacer()
                    ProgressView()
                }
            case .failed(let message):
                Text(message).font(.footnote).foregroundStyle(.secondary)
            case .ready(let profile):
                LabeledContent("Grading plan", value: profile.planLabel)
                LabeledContent("Grades this month", value: "\(profile.gradesUsedThisMonth)")
                if let reset = profile.resetDate {
                    LabeledContent(
                        "Resets",
                        value: reset.formatted(.dateTime.month().day().year())
                    )
                }
            }
        }
    }

    private var dataSection: some View {
        Section {
            Button {
                Task { await runExport() }
            } label: {
                HStack {
                    Label("Export my data", systemImage: "square.and.arrow.up")
                    if isExporting {
                        Spacer()
                        ProgressView()
                    }
                }
            }
            .disabled(isExporting)
        } header: {
            Text("Data")
        } footer: {
            Text("Downloads a JSON file with your profile, submissions, grades, inventory, listings, and sales.")
                .font(.footnote)
        }
    }

    // MARK: - Actions

    private func saveName() async {
        guard case let .signedIn(user) = authStore.phase else { return }
        isSavingName = true
        defer { isSavingName = false }
        if let failure = await store.updateName(nameDraft, userId: user.id.uuidString) {
            errorMessage = failure
            HapticFeedback.error()
        } else {
            HapticFeedback.success()
            // US-1205: visible confirmation (the Save button re-disables on
            // success since nameChanged flips false, so without this nothing
            // signals the save worked).
            withAnimation { nameSaved = true }
            try? await Task.sleep(for: .seconds(2))
            withAnimation { nameSaved = false }
        }
    }

    private func runExport() async {
        isExporting = true
        defer { isExporting = false }
        do {
            let service = AccountExportService()
            let data = try await service.export()
            let url = try service.writeTempFile(data)
            exportFile = ExportFile(url: url)
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            HapticFeedback.error()
        }
    }
}

private struct ExportFile: Identifiable {
    let id = UUID()
    let url: URL
}

/// Thin UIActivityViewController wrapper for the data-export share sheet.
private struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    var onComplete: (() -> Void)?
    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, _ in onComplete?() }
        return controller
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
