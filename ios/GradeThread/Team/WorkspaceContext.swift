import Foundation
import Observation
import Supabase

/// Nonisolated persistence for the active workspace selection (US-670). Read by
/// the data layer off the main actor — the EdgeAPI `X-Workspace-Owner` header
/// and the SyncEngine read-scoping — so it lives in UserDefaults rather than the
/// `@MainActor` ``WorkspaceContext``. `nil` means the user's own (personal)
/// workspace, which the edge defaults to anyway.
enum WorkspaceScope {
    private static let key = "com.gradethread.app.activeWorkspaceOwnerId"

    /// Selected workspace owner id, or nil when operating in the personal workspace.
    static var activeOwnerId: String? {
        get {
            let v = UserDefaults.standard.string(forKey: key)
            return (v?.isEmpty ?? true) ? nil : v
        }
        set {
            if let newValue, !newValue.isEmpty {
                UserDefaults.standard.set(newValue, forKey: key)
            } else {
                UserDefaults.standard.removeObject(forKey: key)
            }
        }
    }

    /// Tenant owner id for data scoping: the active workspace, else the caller.
    static func tenantOwnerId(selfId: String) -> String { activeOwnerId ?? selfId }

    static func clear() { activeOwnerId = nil }

    /// US-794: recover from a mid-session membership revocation. The edge
    /// rejected an X-Workspace-Owner request with `workspace_access_revoked`
    /// because the caller is no longer a member. Drop the stale scope (so
    /// subsequent requests run under the personal tenant), trigger the same
    /// cache reset/re-pull a workspace switch does, and post a one-time notice
    /// for the UI. No-op if there was no active workspace selected. Nonisolated
    /// so the data layer can call it off the main actor.
    static func handleAccessRevoked() {
        guard activeOwnerId != nil else { return }
        clear()
        NotificationCenter.default.post(name: .workspaceDidChange, object: nil)
        NotificationCenter.default.post(name: .workspaceAccessRevoked, object: nil)
    }
}

extension Notification.Name {
    /// Posted after the active workspace changes so the app can reset sync
    /// cursors + the local cache and re-pull the new tenant's data.
    static let workspaceDidChange = Notification.Name("com.gradethread.app.workspaceDidChange")
    /// US-794: posted once when the active workspace membership was revoked
    /// mid-session and the app auto-switched back to the personal workspace —
    /// the UI shows a brief notice.
    static let workspaceAccessRevoked = Notification.Name("com.gradethread.app.workspaceAccessRevoked")
}

/// A workspace the signed-in user can operate within: their own, plus any they
/// were invited to as a member.
struct WorkspaceSummary: Identifiable, Equatable {
    let ownerId: String
    let name: String
    let isPersonal: Bool
    var id: String { ownerId }
}

/// Resolves + switches the active workspace (US-670). The signed-in user always
/// has their personal workspace; membership rows (workspace_members) add the
/// workspaces they were invited to. Switching re-scopes ALL reads/writes — the
/// EdgeAPI header + SyncEngine filter both read ``WorkspaceScope`` — and posts
/// `.workspaceDidChange` so the cache is reset and re-pulled for the new tenant.
@MainActor
@Observable
final class WorkspaceContext {
    enum Phase: Equatable { case loading, ready, failed(String) }

    let selfUserId: String
    var phase: Phase = .loading
    private(set) var workspaces: [WorkspaceSummary] = []

    private let client: SupabaseClient

    init(selfUserId: String, client: SupabaseClient = SupabaseShared.client) {
        self.selfUserId = selfUserId
        self.client = client
    }

    /// The active workspace owner id (selected workspace, else self).
    var activeOwnerId: String { WorkspaceScope.tenantOwnerId(selfId: selfUserId) }

    var activeWorkspace: WorkspaceSummary? {
        workspaces.first { $0.ownerId == activeOwnerId }
    }

    /// True when the user belongs to at least one workspace beyond their own —
    /// the switcher only needs to show when there's something to switch to.
    var hasMultipleWorkspaces: Bool { workspaces.count > 1 }

    func load() async {
        phase = .loading
        do {
            let memberships = try await fetchMemberships()
            var list: [WorkspaceSummary] = [
                WorkspaceSummary(ownerId: selfUserId, name: "My workspace", isPersonal: true),
            ]
            list.append(contentsOf: memberships)
            workspaces = list
            // Drop a stale selection (e.g. membership revoked) back to personal.
            if let active = WorkspaceScope.activeOwnerId,
               !list.contains(where: { $0.ownerId == active }) {
                WorkspaceScope.clear()
            }
            phase = .ready
        } catch {
            // Still expose the personal workspace so the app is usable offline.
            workspaces = [WorkspaceSummary(ownerId: selfUserId, name: "My workspace", isPersonal: true)]
            phase = .failed(error.localizedDescription)
        }
    }

    /// Switches the active workspace and triggers a re-scope. No-op if unchanged.
    func switchTo(ownerId: String) {
        guard ownerId != activeOwnerId else { return }
        WorkspaceScope.activeOwnerId = (ownerId == selfUserId) ? nil : ownerId
        NotificationCenter.default.post(name: .workspaceDidChange, object: nil)
    }

    // MARK: - Private

    private func fetchMemberships() async throws -> [WorkspaceSummary] {
        struct MemberRow: Decodable { let owner_id: String }
        let rows: [MemberRow] = try await client
            .from("workspace_members")
            .select("owner_id")
            .eq("member_id", value: selfUserId)
            .execute()
            .value
        let ownerIds = rows.map(\.owner_id).filter { $0 != selfUserId }
        guard !ownerIds.isEmpty else { return [] }

        // Owner display names (members can read the owner profile per RLS).
        struct OwnerRow: Decodable { let id: String; let full_name: String? }
        let owners: [OwnerRow] = try await client
            .from("users")
            .select("id, full_name")
            .in("id", values: ownerIds)
            .execute()
            .value
        let nameById = Dictionary(owners.map { ($0.id, $0.full_name) }) { a, _ in a }

        return ownerIds.map { id in
            let name = (nameById[id] ?? nil).flatMap { $0.isEmpty ? nil : $0 } ?? "Shared workspace"
            return WorkspaceSummary(ownerId: id, name: name, isPersonal: false)
        }
    }
}
