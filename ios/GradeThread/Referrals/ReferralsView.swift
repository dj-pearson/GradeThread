import SwiftUI

/// Referrals screen (pushed from Settings → Invite friends). Shows the user's
/// code + shareable link, their stats, and a redeem-a-friend's-code form. Reuses
/// the existing `/api/referrals/*` endpoints via `ReferralsStore`.
struct ReferralsView: View {
    @State private var store = ReferralsStore()
    @State private var copied = false

    var body: some View {
        List {
            switch store.phase {
            case .idle, .loading:
                loadingRow
            case .failed(let message):
                failedSection(message)
            case .ready:
                codeSection
                statsSection
                redeemSection
            }
        }
        .navigationTitle("Invite friends")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if store.phase == .idle {
                Telemetry.event("referrals_opened")
                await store.load()
            }
        }
    }

    // MARK: - Loading / failed

    private var loadingRow: some View {
        HStack {
            Spacer()
            ProgressView()
            Spacer()
        }
        .listRowBackground(Color.clear)
    }

    private func failedSection(_ message: String) -> some View {
        Section {
            ContentUnavailableView {
                Label("Couldn't load referrals", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") { Task { await store.load() } }
                    .buttonStyle(.borderedProminent)
            }
        }
    }

    // MARK: - Code + share

    private var codeSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 12) {
                Text(store.me?.code ?? "—")
                    .font(.system(.largeTitle, design: .monospaced).weight(.bold))
                    .foregroundStyle(Color.brandNavy)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .accessibilityLabel("Your referral code is \(store.me?.code ?? "")")

                HStack(spacing: 12) {
                    Button {
                        copyCode()
                    } label: {
                        Label(copied ? "Copied" : "Copy code",
                              systemImage: copied ? "checkmark" : "doc.on.doc")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)

                    if let url = store.referralURL {
                        ShareLink(item: url,
                                  subject: Text("Grade your closet with GradeThread"),
                                  message: Text("Use my link to join GradeThread.")) {
                            Label("Share link", systemImage: "square.and.arrow.up")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .simultaneousGesture(TapGesture().onEnded {
                            HapticFeedback.light()
                            Telemetry.event("referral_link_shared")
                        })
                    }
                }
            }
            .padding(.vertical, 4)
        } header: {
            Text("Your code")
        } footer: {
            Text("Share your link. When a friend signs up and grades their first item, you both earn a reward.")
        }
    }

    // MARK: - Stats

    @ViewBuilder
    private var statsSection: some View {
        Section("Your referrals") {
            if (store.me?.stats.total ?? 0) == 0 {
                // US-1129: explain the program instead of three lonely zeros
                // before the user has referred anyone.
                VStack(spacing: 8) {
                    Image(systemName: "person.2.wave.2")
                        .font(.title)
                        .foregroundStyle(Color.brandNavy)
                    Text("No referrals yet")
                        .font(.subheadline.weight(.semibold))
                    Text("Share your link above. Once a friend signs up and grades their first item, they'll show up here and you'll both earn a reward.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("No referrals yet. Share your link to get started.")
            } else {
                HStack(spacing: 0) {
                    stat("Referred", value: store.me?.stats.total ?? 0)
                    Divider()
                    stat("In progress", value: store.inProgress)
                    Divider()
                    stat("Rewarded", value: store.me?.stats.granted ?? 0)
                }
                .frame(maxWidth: .infinity)
            }
        }
    }

    private func stat(_ label: String, value: Int) -> some View {
        VStack(spacing: 4) {
            Text("\(value)")
                .font(.title2.weight(.bold))
                .foregroundStyle(Color.brandNavy)
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(value) \(label)")
    }

    // MARK: - Redeem

    @ViewBuilder
    private var redeemSection: some View {
        if store.alreadyReferred {
            Section {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("You were referred")
                            .font(.subheadline.weight(.semibold))
                        if let by = store.me?.referredBy {
                            Text("Code \(by.code) · \(by.status.capitalized)")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                } icon: {
                    Image(systemName: "checkmark.seal.fill")
                        .foregroundStyle(Color.brandEmerald)
                }
            }
        } else {
            Section {
                TextField("Friend's code", text: Binding(
                    get: { store.redeemCode },
                    set: { store.redeemCode = $0 }
                ))
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .font(.system(.body, design: .monospaced))

                Button {
                    Task { await applyCode() }
                } label: {
                    HStack {
                        Text("Apply code")
                        if store.isRedeeming {
                            Spacer()
                            ProgressView()
                        }
                    }
                }
                .disabled(!store.canRedeem)

                if let error = store.redeemError {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(Color.brandRed)
                }
            } header: {
                Text("Have a code?")
            } footer: {
                Text("Enter a friend's code to credit them for your signup.")
            }
        }
    }

    // MARK: - Actions

    private func copyCode() {
        guard let code = store.me?.code, !code.isEmpty else { return }
        // US-697: keep the referral code local-only with a short expiry.
        SecurePasteboard.copy(code)
        HapticFeedback.light()
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(2))
            copied = false
        }
    }

    private func applyCode() async {
        let ok = await store.redeem()
        if ok {
            HapticFeedback.success()
            Telemetry.event("referral_redeemed")
        } else {
            HapticFeedback.error()
        }
    }
}
