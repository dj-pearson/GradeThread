import SwiftUI

/// Team management for the workspace you own (pushed from Settings → Team).
/// Invite teammates, manage their roles, and handle pending invitations.
/// Reuses `/api/workspace/*` + Supabase via `TeamStore`.
struct TeamView: View {
    @State private var store: TeamStore
    @State private var removeTarget: WorkspaceMember?
    @State private var copiedInvite = false

    init(ownerId: String) {
        _store = State(initialValue: TeamStore(ownerId: ownerId))
    }

    var body: some View {
        Form {
            switch store.phase {
            case .idle, .loading:
                loadingRow
            case .failed(let message):
                failed(message)
            case .ready:
                inviteSection
                membersSection
                if !store.invitations.isEmpty {
                    invitationsSection
                }
            }
        }
        .navigationTitle("Team")
        .navigationBarTitleDisplayMode(.inline)
        .alert("Remove member?", isPresented: Binding(
            get: { removeTarget != nil },
            set: { if !$0 { removeTarget = nil } }
        ), presenting: removeTarget) { member in
            Button("Remove", role: .destructive) {
                Task {
                    await store.remove(memberId: member.memberId)
                    HapticFeedback.warning()
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: { member in
            Text("\(member.displayName) will lose access to this workspace. You can re-invite them later.")
        }
        .alert("Something went wrong", isPresented: Binding(
            get: { store.actionError != nil },
            set: { if !$0 { store.actionError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.actionError ?? "")
        }
        .task {
            if store.phase == .idle {
                Telemetry.event("team_opened")
                await store.load()
            }
        }
    }

    // MARK: - Loading / failed

    // US-1200: shared skeleton + error components for a consistent load/fail UX.
    private var loadingRow: some View {
        SkeletonRows(count: 4)
            .listRowBackground(Color.clear)
            // US-1223: skeleton placeholders are silent to VoiceOver — speak a
            // "Loading" cue so the load state is announced.
            .accessibilityElement()
            .accessibilityLabel("Loading")
            .accessibilityAddTraits(.updatesFrequently)
    }

    private func failed(_ message: String) -> some View {
        Section {
            ErrorStateView(
                title: "Couldn't load your team",
                message: message,
                retry: { await store.load() }
            )
        }
    }

    // MARK: - Invite

    private var emailBinding: Binding<String> {
        Binding(get: { store.inviteEmail }, set: { store.inviteEmail = $0 })
    }
    private var roleBinding: Binding<WorkspaceRole> {
        Binding(get: { store.inviteRole }, set: { store.inviteRole = $0 })
    }

    private var inviteSection: some View {
        Section {
            TextField("teammate@email.com", text: emailBinding)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.emailAddress)
                .textContentType(.emailAddress)

            Picker("Role", selection: roleBinding) {
                ForEach(WorkspaceRole.assignable, id: \.self) { role in
                    Text(role.label).tag(role)
                }
            }

            Button {
                Task { await sendInvite() }
            } label: {
                HStack {
                    Label("Send invite", systemImage: "paperplane")
                    if store.isInviting {
                        Spacer()
                        ProgressView()
                    }
                }
            }
            .disabled(!store.canInvite)

            if let error = store.inviteError {
                Text(error).font(.footnote).foregroundStyle(Color.brandRed)
            }

            if let invite = store.lastInvite {
                inviteBanner(invite)
            }
        } header: {
            Text("Invite a teammate")
        } footer: {
            Text("\(store.inviteRole.label): \(store.inviteRole.summary)")
        }
    }

    @ViewBuilder
    private func inviteBanner(_ invite: CreateInviteResponse) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(
                invite.emailSent
                    ? "Invitation sent to \(invite.email)."
                    : "Invite created — email didn't send. Share the link:",
                systemImage: invite.emailSent ? "checkmark.circle.fill" : "exclamationmark.circle.fill"
            )
            .font(.footnote)
            .foregroundStyle(invite.emailSent ? Color.brandEmerald : Color.brandAmber)

            HStack(spacing: 12) {
                Button {
                    // US-697: invite-accept URLs are capability tokens — copy
                    // local-only with a short expiry.
                    SecurePasteboard.copy(invite.acceptUrl)
                    HapticFeedback.light()
                    copiedInvite = true
                    Task { try? await Task.sleep(for: .seconds(2)); copiedInvite = false }
                } label: {
                    Label(copiedInvite ? "Copied" : "Copy link",
                          systemImage: copiedInvite ? "checkmark" : "doc.on.doc")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)

                if let url = store.lastInviteURL {
                    ShareLink(item: url) {
                        Label("Share", systemImage: "square.and.arrow.up")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: - Members

    private var membersSection: some View {
        Section {
            // Synthetic owner row (you).
            HStack {
                Label("You", systemImage: "person.crop.circle.fill")
                Spacer()
                Text(WorkspaceRole.owner.label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.brandNavy)
            }

            ForEach(store.members) { member in
                memberRow(member)
            }

            if store.members.isEmpty {
                Text("No teammates yet. Invite someone above.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Members")
        } footer: {
            Text("You're the owner — full access, can't be removed. Set each teammate's role below.")
        }
    }

    private func memberRow(_ member: WorkspaceMember) -> some View {
        let memberRoleBinding = Binding<WorkspaceRole>(
            get: { member.role },
            set: { newRole in Task { await store.updateRole(memberId: member.memberId, to: newRole) } }
        )
        return VStack(alignment: .leading, spacing: 6) {
            // US-1223: combine name + email into one element so the row reads as
            // a unit; the role Picker stays a separate interactive control.
            VStack(alignment: .leading, spacing: 2) {
                Text(member.displayName).font(.body)
                if member.name != nil, !member.email.isEmpty {
                    Text(member.email).font(.caption).foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .combine)
            Picker("Role", selection: memberRoleBinding) {
                ForEach(WorkspaceRole.assignable, id: \.self) { role in
                    Text(role.label).tag(role)
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            // `.labelsHidden()` strips the picker's label, so VoiceOver announced
            // a bare role with no owner. Name the control per member.
            .accessibilityLabel("\(member.displayName) role")
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) {
                removeTarget = member
            } label: {
                Label("Remove", systemImage: "person.badge.minus")
            }
        }
    }

    // MARK: - Pending invitations

    private var invitationsSection: some View {
        Section("Pending invitations") {
            ForEach(store.invitations) { invite in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(invite.email).font(.body)
                        Text("\(invite.role.label) · expires \(expiry(invite))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Menu {
                        Button {
                            Task { await resend(invite.id) }
                        } label: { Label("Resend email", systemImage: "paperplane") }
                        Button {
                            copyAcceptLink(invite)
                        } label: { Label("Copy link", systemImage: "doc.on.doc") }
                        Button(role: .destructive) {
                            Task { await store.revoke(invite.id); HapticFeedback.warning() }
                        } label: { Label("Revoke", systemImage: "trash") }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .foregroundStyle(Color.brandNavy)
                    }
                }
            }
        }
    }

    private func expiry(_ invite: WorkspaceInvitation) -> String {
        guard let date = invite.expiresDate() else { return "soon" }
        return date.formatted(.dateTime.month().day())
    }

    // MARK: - Actions

    private func sendInvite() async {
        let ok = await store.invite()
        if ok {
            HapticFeedback.success()
            Telemetry.event("team_member_invited", props: ["role": store.inviteRole.rawValue])
        } else {
            HapticFeedback.error()
        }
    }

    private func resend(_ id: String) async {
        let sent = await store.resend(id)
        switch sent {
        case .some(true): HapticFeedback.success()
        case .some(false): HapticFeedback.warning()
        case .none: HapticFeedback.error()
        }
    }

    private func copyAcceptLink(_ invite: WorkspaceInvitation) {
        if let url = store.acceptURL(for: invite) {
            // US-697: capability URL — local-only + short expiry.
            SecurePasteboard.copy(url.absoluteString)
            HapticFeedback.light()
        }
    }
}
