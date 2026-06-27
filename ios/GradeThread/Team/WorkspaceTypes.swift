import Foundation

// Team / workspace wire + UI models. Mirror the web (`src/pages/team.tsx`,
// `src/lib/workspace-permissions.ts`) and the edge route `routes/workspace.ts`
// + migration 00042.
//
// Supabase rows are decoded by supabase-swift's decoder, which does NOT convert
// snake_case — so those structs carry explicit CodingKeys (matching ProfileStore).
// Edge responses go through EdgeAPI's convertFromSnakeCase decoder, so they use
// plain camelCase with no CodingKeys.

/// Workspace role. Hierarchy (low→high): viewer < member < listingManager <
/// admin < owner. `owner` is never assignable (it's the workspace owner only).
enum WorkspaceRole: String, Codable, CaseIterable, Equatable {
    case viewer
    case member
    case listingManager = "listing_manager"
    case admin
    case owner

    /// Roles an owner/admin can assign when inviting (mirrors the web).
    static let assignable: [WorkspaceRole] = [.admin, .listingManager, .member, .viewer]

    /// Hierarchy rank (low→high). Mirrors web `ROLE_RANK`
    /// (`src/lib/workspace-permissions.ts`) + migration 00042.
    var rank: Int {
        switch self {
        case .viewer: return 1
        case .member: return 2
        case .listingManager: return 3
        case .admin: return 4
        case .owner: return 5
        }
    }

    /// Whether this role can manage members — invite, change roles, remove,
    /// revoke. Mirrors the web `manage_members` capability (min role = admin).
    var canManageMembers: Bool { rank >= WorkspaceRole.admin.rank }

    var label: String {
        switch self {
        case .owner: return "Owner"
        case .admin: return "Admin"
        case .listingManager: return "Manager"
        case .member: return "Staff"
        case .viewer: return "Viewer"
        }
    }

    var summary: String {
        switch self {
        case .owner: return "Full access including billing."
        case .admin: return "Manage members, marketplaces and API keys. No billing."
        case .listingManager: return "Create and edit inventory, listings and grades."
        case .member: return "Submit grades and view all data."
        case .viewer: return "Read-only access."
        }
    }
}

// MARK: - Supabase rows

/// `workspace_members` row.
struct WorkspaceMemberRow: Decodable, Equatable {
    let id: String
    let ownerId: String
    let memberId: String
    let role: WorkspaceRole
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, role
        case ownerId = "owner_id"
        case memberId = "member_id"
        case createdAt = "created_at"
    }
}

/// Slim `users` projection joined onto a member row.
struct WorkspaceUserLite: Decodable, Equatable {
    let id: String
    let email: String
    let fullName: String?

    enum CodingKeys: String, CodingKey {
        case id, email
        case fullName = "full_name"
    }
}

/// `workspace_invitations` row (also the UI model). `acceptedAt`/`revokedAt`
/// drive the client-side "active" filter; `expiresAt` the expiry filter.
struct WorkspaceInvitation: Decodable, Identifiable, Equatable {
    let id: String
    let email: String
    let role: WorkspaceRole
    let token: String
    let expiresAt: String
    let acceptedAt: String?
    let revokedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, email, role, token
        case expiresAt = "expires_at"
        case acceptedAt = "accepted_at"
        case revokedAt = "revoked_at"
    }

    func expiresDate() -> Date? { WorkspaceDate.parse(expiresAt) }

    /// Pending (not accepted, not revoked) and not past its expiry.
    func isActive(now: Date) -> Bool {
        guard acceptedAt == nil, revokedAt == nil else { return false }
        if let expiry = expiresDate() { return expiry > now }
        return true
    }
}

// MARK: - Combined member (member row + profile)

/// A workspace member as shown in the UI (membership row joined with profile).
struct WorkspaceMember: Identifiable, Equatable {
    let id: String          // membership row id
    let memberId: String    // users.id
    let email: String
    let name: String?
    let role: WorkspaceRole
    let createdAt: String

    var displayName: String {
        if let name, !name.isEmpty { return name }
        return email.isEmpty ? "Member" : email
    }
}

// MARK: - Edge responses (convertFromSnakeCase)

/// `POST /api/workspace/invitations`.
struct CreateInviteResponse: Decodable, Equatable {
    let id: String
    let email: String
    let role: WorkspaceRole
    let token: String
    let acceptUrl: String
    let emailSent: Bool
}

/// `POST /api/workspace/invitations/:id/resend`.
struct ResendInviteResponse: Decodable, Equatable {
    let emailSent: Bool
    let acceptUrl: String
}

// MARK: - Pure helpers

enum WorkspaceInvites {
    /// Filter to invitations that are still pending + unexpired.
    static func active(_ rows: [WorkspaceInvitation], now: Date) -> [WorkspaceInvitation] {
        rows.filter { $0.isActive(now: now) }
    }
}

enum WorkspaceEmail {
    /// Lightweight client-side check; the edge remains authoritative.
    static func isValid(_ raw: String) -> Bool {
        let email = raw.trimmed
        return email.range(of: #"^[^@\s]+@[^@\s]+\.[^@\s]+$"#, options: .regularExpression) != nil
    }
}

enum WorkspaceDate {
    static func parse(_ raw: String) -> Date? {
        let withFractional = ISO8601DateFormatter()
        withFractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return withFractional.date(from: raw) ?? ISO8601DateFormatter().date(from: raw)
    }
}
