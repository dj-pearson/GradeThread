import Foundation
import Observation

/// Client mirror of the server-authoritative photo profiles
/// (services/edge-functions/src/lib/photo-profiles.ts). A profile maps an
/// `item_category` to the ordered photo "roles" a seller should capture, with
/// category-specific labels, hints, and required flags — so a watch is asked
/// for a dial/caseback/serial instead of a garment's front/back/tag/detail.
///
/// The full table is fetched from `GET /api/flipdesk/photo-profiles` via
/// ``PhotoProfileStore`` and cached; the small bundled fallback below keeps the
/// UI usable offline / before the first fetch. The server table always wins
/// once it loads, so the fallback only needs to be "good enough".

public struct PhotoRole: Decodable, Hashable {
    /// Physical `item_photos.photo_type` value this slot writes.
    public let type: String
    /// US-2468 (migration 00587): the `item_photos.photo_role` qualifier this
    /// slot writes, or nil for a slot that takes none. Slot identity is
    /// (type, role) — that is what lets a suit hold three separate `tag` slots
    /// instead of needing a `tag_2` and a `tag_3` in the enum.
    public let role: String?
    /// Category-specific display label, e.g. "Dial / Face", "Front of card".
    public let label: String
    /// One-line capture guidance.
    public let hint: String
    /// Must be present before the item can advance to "photographed".
    public let required: Bool
    /// lucide icon name (web); iOS maps the slot to an SF Symbol via PhotoSlotType.
    public let icon: String
}

public struct PhotoProfile: Decodable, Hashable, Identifiable {
    /// `item_category` value this profile applies to.
    public let category: String
    /// Human category name for headers.
    public let label: String
    /// Ordered capture roles — required ones first by convention.
    public let roles: [PhotoRole]

    public var id: String { category }

    /// Required roles resolved to capture slots (unmappable types skipped).
    public var requiredSlots: [PhotoSlotType] {
        roles.filter { $0.required }.compactMap { PhotoSlotType(serverType: $0.type) }
    }

    /// Optional, non-defect roles resolved to capture slots. Defects keep
    /// their own reveal-one-at-a-time mechanism in the capture flow, so they
    /// are excluded here.
    public var optionalSlots: [PhotoSlotType] {
        roles
            .filter { !$0.required && $0.type != "defect" }
            .compactMap { PhotoSlotType(serverType: $0.type) }
    }

    /// Whether this category offers defect close-ups.
    public var allowsDefects: Bool {
        roles.contains { $0.type == "defect" }
    }

    /// The role definition for a given server photo type, if the profile has one.
    public func role(forServerType serverType: String) -> PhotoRole? {
        roles.first { $0.type == serverType }
    }

    /// US-2468: the role definition for a stored (type, role) PAIR. Prefer this
    /// over ``role(forServerType:)`` whenever the caller has both halves — a
    /// suit profile has three `tag` slots and the type alone picks the wrong
    /// one two times out of three.
    public func role(forServerType serverType: String, photoRole: String?) -> PhotoRole? {
        roles.first { $0.type == serverType && $0.role == photoRole }
            ?? roles.first { $0.type == serverType && $0.role == nil }
    }

    /// Stable identity for a slot: "type" or "type:role".
    public static func slotKey(_ type: String, _ role: String?) -> String {
        guard let role, !role.isEmpty else { return type }
        return "\(type):\(role)"
    }

    // MARK: - Bundled fallback

    public static let clothingFallback = PhotoProfile(
        category: "clothing",
        label: "Clothing",
        roles: [
            PhotoRole(type: "front", role: nil, label: "Front", hint: "Lay flat, full front in frame", required: true, icon: "shirt"),
            PhotoRole(type: "back", role: nil, label: "Back", hint: "Same crop as the front shot", required: true, icon: "shirt"),
            PhotoRole(type: "tag", role: nil, label: "Garment Tag", hint: "Care + size label, close enough to read", required: true, icon: "tag"),
            PhotoRole(type: "detail", role: nil, label: "Detail", hint: "Texture, weave, or a distinctive feature", required: true, icon: "search"),
            PhotoRole(type: "defect", role: nil, label: "Defect", hint: "Tight crop on any flaw — be honest", required: false, icon: "alert-triangle"),
        ]
    )

    public static let genericFallback = PhotoProfile(
        category: "other",
        label: "Other",
        roles: [
            PhotoRole(type: "front", role: nil, label: "Front", hint: "Main view in frame", required: true, icon: "image"),
            PhotoRole(type: "back", role: nil, label: "Back", hint: "Reverse view", required: true, icon: "image"),
            PhotoRole(type: "detail", role: nil, label: "Detail", hint: "Distinguishing detail or label", required: false, icon: "search"),
            PhotoRole(type: "defect", role: nil, label: "Defect", hint: "Tight crop on any flaw — be honest", required: false, icon: "alert-triangle"),
        ]
    )

    public static let bundledFallback: [String: PhotoProfile] = [
        "clothing": clothingFallback,
        "other": genericFallback,
    ]
}

/// Fetches + caches the photo-profile table. Static config → a single fetch
/// per session (server-cached too). Falls back to the bundled profiles when
/// the network is unavailable so callers can always resolve a profile.
@MainActor
@Observable
public final class PhotoProfileStore {
    public private(set) var profiles: [String: PhotoProfile] = PhotoProfile.bundledFallback
    private var loaded = false

    public init() {}

    /// Resolves the profile for an `item_category`, falling back to clothing
    /// (the historical default) for null/unknown categories.
    public func profile(for category: String?) -> PhotoProfile {
        if let category, let match = profiles[category] {
            return match
        }
        return profiles["clothing"] ?? PhotoProfile.clothingFallback
    }

    /// US-2468: resolves the profile for an item, consulting the free-text
    /// GARMENT word ("blazer", "dress pants") as well as the item_category.
    ///
    /// Mirrors `getPhotoProfile(category, garment)` on the edge, including its
    /// fallback: when no usable item_category is given, the garment word is
    /// used to resolve a group and that group is mapped back to an
    /// item_category profile where one exists. That matters because
    /// `items_full` has no item_category column at all, so the free-text word
    /// is often the only category signal a caller actually has.
    public func profile(for category: String?, garment: String?) -> PhotoProfile {
        if let category, category != "clothing", let match = profiles[category] {
            return match
        }
        let group = GarmentGroup.from(garment ?? category)
        if let key = group.itemCategoryProfileKey, let match = profiles[key] {
            return match
        }
        return profiles[group.clothingProfileKey]
            ?? profiles["clothing"]
            ?? PhotoProfile.clothingFallback
    }

    /// Loads the table from the edge once. Safe to call repeatedly.
    public func loadIfNeeded() async {
        guard !loaded else { return }
        struct Wrapper: Decodable { let profiles: [String: PhotoProfile] }
        do {
            let resp: Wrapper = try await EdgeAPI.shared.getJSON(
                "/api/flipdesk/photo-profiles",
                cacheTTL: 3600
            )
            if !resp.profiles.isEmpty {
                profiles = resp.profiles
                loaded = true
            }
        } catch {
            // Keep the bundled fallback — non-fatal; we retry next launch.
        }
    }
}
