import SwiftUI

/// Team management for the active workspace (pushed from Settings → Team).
/// Invite teammates, manage their roles, and handle pending invitations. The
/// write controls only appear when the caller's role can manage members; a
/// member/viewer sees a read-only roster. Reuses `/api/workspace/*` + Supabase
/// via `TeamStore`.
struct TeamView: View {
    @State private var store: TeamStore
    @State private var removeTarget: WorkspaceMember?
    @State private var copiedInvite = false

    /// - Parameters:
    ///   - ownerId: the active workspace owner whose team is managed (pass
    ///     `WorkspaceScope.tenantOwnerId(selfId:)`, NOT always the signed-in id).
    ///   - selfId: the signed-in user's id, used to resolve their own role.
    init(ownerId: String, selfId: String) {
        _store = State(initialValue: TeamStore(ownerId: ownerId, selfId: selfId))
    }

    var body: some View {
        Form {
            switch store.phase {
            case .idle, .loading:
                loadingRow
            case .failed(let message):
                failed(message)
            case .ready:
                // US-1254: only managers (owner/admin) get the invite form.
                if store.canManageMembers {
                    inviteSection
                }
                membersSection
                // US-2532: the 2FA requirement was web-only, which made a
                // security control desktop-only. Owner sets it; an admin can see
                // it (the edge allows the read and refuses the write).
                if store.canManageMembers {
                    mfaPolicySection
                }
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
            // Synthetic "you" row — reflects the caller's REAL role in this
            // workspace, not an assumed owner (US-1254).
            HStack {
                Label("You", systemImage: "person.crop.circle.fill")
                Spacer()
                Text(store.currentRole.label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.brandNavy)
            }

            ForEach(store.otherMembers) { member in
                memberRow(member)
            }

            if store.otherMembers.isEmpty {
                Text(store.canManageMembers
                    ? "No teammates yet. Invite someone above."
                    : "No other teammates in this workspace yet.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Members")
        } footer: {
            Text(membersFooter)
        }
    }

    private var membersFooter: String {
        if store.isOwner {
            return "You're the owner — full access, can't be removed. Set each teammate's role below."
        }
        if store.canManageMembers {
            return "You're an admin — you can invite teammates and set their roles."
        }
        return "You have \(store.currentRole.label.lowercased()) access. Only the owner or an admin can change the team."
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
            if store.canManageMembers {
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
            } else {
                // Read-only roster for members/viewers (US-1254).
                Text(member.role.label)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("\(member.displayName) role: \(member.role.label)")
            }
        }
        .swipeActions(edge: .trailing) {
            if store.canManageMembers {
                Button(role: .destructive) {
                    removeTarget = member
                } label: {
                    Label("Remove", systemImage: "person.badge.minus")
                }
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
                    // US-1254: resend / copy capability-link / revoke are
                    // member-management actions — managers only.
                    if store.canManageMembers {
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
                        .accessibilityLabel("Invite actions")
                    }
                }
            }
        }
    }

    /// US-2532: the workspace 2FA requirement, mirroring the web card's options
    /// and its refusal to guess.
    private var mfaPolicySection: some View {
        Section {
            if store.mfaLoadFailed {
                // ⚠ NOT a picker defaulted to "Not required". A failed read
                // rendered as off reads like an explicit, safe setting when the
                // truth is unknown — US-2185 on web, same reasoning here.
                VStack(alignment: .leading, spacing: Spacing.xxs) {
                    Text("Couldn't load the 2FA requirement.")
                        .font(.subheadline)
                    Button("Try again") { Task { await store.loadMfaPolicy() } }
                        .font(.subheadline)
                }
            } else {
                Picker("Require 2FA", selection: mfaBinding) {
                    ForEach(TeamView.mfaOptions) { option in
                        Text(option.label).tag(option.role)
                    }
                }
                .disabled(!store.isOwner || store.mfaSaving)
                Text(TeamView.mfaHint(for: store.mfaPolicy))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if !store.isOwner {
                    // The edge refuses a non-owner write; saying so beats a 403
                    // the user has to trigger to discover.
                    Text("Only the workspace owner can change this.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        } header: {
            Text("Two-factor authentication")
        }
    }

    /// The picker works in `WorkspaceRole?` where nil is "not required", so the
    /// binding maps the selection straight onto the value the endpoint takes —
    /// there is no "off" sentinel to translate, and inventing one is how a
    /// literal "off" ends up sent as a role.
    private var mfaBinding: Binding<WorkspaceRole?> {
        Binding(
            get: { store.mfaPolicy },
            set: { next in Task { await store.setMfaPolicy(next) } }
        )
    }

    /// One choice in the 2FA picker. A struct rather than a tuple so the
    /// ForEach identity is unambiguous — `nil` is a real option here (it means
    /// "not required"), so the id cannot be the role itself.
    fileprivate struct MfaOption: Identifiable {
        let role: WorkspaceRole?
        let label: String
        var id: String { role?.rawValue ?? "off" }
    }

    fileprivate static let mfaOptions: [MfaOption] = [
        MfaOption(role: nil, label: "Not required"),
        MfaOption(role: .admin, label: "Admins"),
        MfaOption(role: .listingManager, label: "Managers and above"),
        MfaOption(role: .member, label: "Staff and above"),
        MfaOption(role: .viewer, label: "Everyone"),
    ]

    fileprivate static func mfaHint(for role: WorkspaceRole?) -> String {
        switch role {
        case .none: return "Members sign in with a password only."
        case .admin: return "Admins must use 2FA."
        case .listingManager: return "Managers and Admins must use 2FA."
        case .member: return "Everyone except Viewers must use 2FA."
        case .viewer: return "All members must use 2FA."
        case .owner: return "Only the owner must use 2FA."
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
