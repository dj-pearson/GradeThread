import SwiftUI

/// GradeThread Verified seller-profile editor (pushed from Settings → Verified
/// seller). Claim a handle, set display name + bio, toggle the profile public,
/// and share the public link. Reuses `/api/verified/*` via `VerifiedStore`.
struct VerifiedView: View {
    @State private var store = VerifiedStore()
    @State private var handleCheckTask: Task<Void, Never>?
    /// US-1129: reveal the claim form when an unclaimed seller taps "Get started".
    @State private var showingForm = false

    var body: some View {
        Form {
            switch store.phase {
            case .idle, .loading:
                loadingRow
            case .failed(let message):
                failed(message)
            case .ready where isUnclaimed && !showingForm:
                unclaimedSection
            case .ready:
                handleSection
                detailsSection
                visibilitySection
                if (store.stats?.totalGraded ?? 0) > 0 {
                    statsSection
                }
                if store.original?.enabled == true, store.publicProfileURL != nil {
                    shareSection
                }
            }
        }
        .navigationTitle("Verified seller")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if store.isSaving {
                    ProgressView()
                } else {
                    Button("Save") { Task { await save() } }
                        .disabled(!store.canSave)
                }
            }
        }
        .alert("Couldn't save", isPresented: Binding(
            get: { store.saveError != nil },
            set: { if !$0 { store.saveError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.saveError ?? "")
        }
        .task {
            if store.phase == .idle {
                Telemetry.event("verified_opened")
                await store.load()
            }
        }
    }

    // MARK: - Unclaimed empty state

    /// True when the seller hasn't claimed a handle and the profile is private —
    /// the "before you've set anything up" state. We explain the value first
    /// rather than dropping the user into a form full of 0s and "—".
    private var isUnclaimed: Bool {
        (store.original?.handle ?? "").isEmpty && store.original?.enabled != true
    }

    private var unclaimedSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 16) {
                Image(systemName: "checkmark.shield.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(Color.brandNavy)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 8)
                Text("Become a Verified seller")
                    .font(.title3.weight(.bold))
                    .frame(maxWidth: .infinity)
                    .multilineTextAlignment(.center)
                Text("Claim a public handle and earn a trust badge. Buyers see your verified grades, average condition score, and how long you've been on GradeThread — proof your listings are graded to a standard.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                Button {
                    HapticFeedback.light()
                    showingForm = true
                } label: {
                    Text("Claim your handle")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.brandNavy)
                .controlSize(.large)
            }
            .padding(.vertical, 8)
            .listRowBackground(Color.clear)
        }
    }

    // MARK: - Bindings

    private var handleBinding: Binding<String> {
        Binding(get: { store.handleDraft }, set: { store.handleDraft = $0 })
    }
    private var displayNameBinding: Binding<String> {
        Binding(get: { store.displayNameDraft }, set: { store.displayNameDraft = $0 })
    }
    private var bioBinding: Binding<String> {
        Binding(get: { store.bioDraft }, set: { store.bioDraft = $0 })
    }
    private var enabledBinding: Binding<Bool> {
        Binding(get: { store.enabled }, set: { store.enabled = $0 })
    }
    private var showListingsBinding: Binding<Bool> {
        Binding(get: { store.showListings }, set: { store.showListings = $0 })
    }

    // MARK: - Loading / failed

    private var loadingRow: some View {
        HStack { Spacer(); ProgressView(); Spacer() }
            .listRowBackground(Color.clear)
    }

    private func failed(_ message: String) -> some View {
        Section {
            ContentUnavailableView {
                Label("Couldn't load your profile", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") { Task { await store.load() } }
                    .buttonStyle(.borderedProminent)
            }
        }
    }

    // MARK: - Handle

    private var handleSection: some View {
        Section {
            HStack(spacing: 4) {
                Text("@").foregroundStyle(.secondary)
                TextField("your-handle", text: handleBinding)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textContentType(.username)
                    .font(.system(.body, design: .monospaced))
                    .onChange(of: store.handleDraft) { _, _ in scheduleHandleCheck() }
            }
            handleStatusRow
        } header: {
            Text("Handle")
        } footer: {
            Text("Your public profile lives at gradethread.com/verified/\(displayHandle). Lowercase letters, numbers and hyphens.")
        }
    }

    private var displayHandle: String {
        let normalized = VerifiedHandle.normalize(store.handleDraft)
        return normalized.isEmpty ? "your-handle" : normalized
    }

    @ViewBuilder
    private var handleStatusRow: some View {
        if let localError = store.handleLocalError {
            statusLabel(localError, system: "xmark.circle.fill", color: .brandRed)
        } else {
            switch store.handleCheck {
            case .checking:
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Checking availability…").foregroundStyle(.secondary)
                }
                .font(.footnote)
            case .ok:
                statusLabel("Available", system: "checkmark.circle.fill", color: .brandEmerald)
            case .taken(let reason), .invalid(let reason):
                statusLabel(reason, system: "xmark.circle.fill", color: .brandRed)
            case .idle:
                EmptyView()
            }
        }
    }

    private func statusLabel(_ text: String, system: String, color: Color) -> some View {
        Label {
            Text(text).foregroundStyle(.secondary)
        } icon: {
            Image(systemName: system).foregroundStyle(color)
        }
        .font(.footnote)
    }

    // MARK: - Details

    private var detailsSection: some View {
        Section {
            TextField("Display name", text: displayNameBinding)
                .textInputAutocapitalization(.words)
            TextField("Bio", text: bioBinding, axis: .vertical)
                .lineLimit(3...6)
        } header: {
            Text("Profile")
        } footer: {
            Text("\(store.bioDraft.count)/\(VerifiedStore.maxBio)")
                .monospacedDigit()
                .foregroundStyle(store.bioDraft.count > VerifiedStore.maxBio ? Color.brandRed : .secondary)
        }
    }

    // MARK: - Visibility

    private var visibilitySection: some View {
        Section {
            Toggle("Public profile", isOn: enabledBinding)
                .tint(.brandNavy)
            Toggle("Show my listings (storefront)", isOn: showListingsBinding)
                .tint(.brandNavy)
                .disabled(!store.enabled)
        } footer: {
            if store.needsHandleToEnable {
                Label("Claim a handle before making your profile public.",
                      systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(Color.brandRed)
            } else {
                Text("When public, anyone with your link can see your verified grades and stats. Turn on listings to also show your active items — graded ones link to their certificate, the rest to their marketplace listing.")
            }
        }
    }

    // MARK: - Stats

    private var statsSection: some View {
        Section("Your grading record") {
            LabeledContent("Items graded", value: "\(store.stats?.totalGraded ?? 0)")
            LabeledContent(
                "Average grade",
                value: (store.stats?.averageGrade ?? 0) > 0
                    ? String(format: "%.1f / 10", store.stats?.averageGrade ?? 0)
                    : "—"
            )
            if let since = formattedVerifiedSince {
                LabeledContent("Verified since", value: since)
            }
        }
    }

    private var formattedVerifiedSince: String? {
        guard let raw = store.original?.verifiedSince, !raw.isEmpty else { return nil }
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        guard let date = withFractional.date(from: raw) ?? plain.date(from: raw) else { return nil }
        return date.formatted(.dateTime.month(.wide).year())
    }

    // MARK: - Share

    @ViewBuilder
    private var shareSection: some View {
        if let url = store.publicProfileURL {
            Section {
                ShareLink(item: url,
                          subject: Text("My GradeThread Verified profile"),
                          message: Text("See my verified grades on GradeThread.")) {
                    Label("Share my profile", systemImage: "square.and.arrow.up")
                }
                .simultaneousGesture(TapGesture().onEnded {
                    HapticFeedback.light()
                    Telemetry.event("verified_profile_shared")
                })
                Link(destination: url) {
                    Label(store.showListings ? "View my shop" : "View public profile",
                          systemImage: "safari")
                }
            } footer: {
                Text(url.absoluteString)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Actions

    private func scheduleHandleCheck() {
        handleCheckTask?.cancel()
        handleCheckTask = Task {
            try? await Task.sleep(for: .milliseconds(400))
            if Task.isCancelled { return }
            await store.checkHandleAvailability()
        }
    }

    private func save() async {
        let ok = await store.save()
        if ok {
            HapticFeedback.success()
            Telemetry.event("verified_saved", props: ["enabled": store.enabled])
        } else {
            HapticFeedback.error()
        }
    }
}
