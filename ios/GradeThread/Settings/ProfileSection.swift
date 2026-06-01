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
            ShareSheet(items: [file.url])
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
                    }
                }
            }
            .disabled(isSavingName || !nameChanged)
        }
    }

    private var planSection: some View {
        Section("Plan & usage") {
            switch store.phase {
            case .loading:
                HStack {
                    Text("Plan")
                    Spacer()
                    ProgressView()
                }
            case .failed(let message):
                Text(message).font(.footnote).foregroundStyle(.secondary)
            case .ready(let profile):
                LabeledContent("Plan", value: profile.planLabel)
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
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
