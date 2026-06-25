import SwiftUI

/// View-model for the Verified Seller profile screen. Loads the caller's profile
/// + stats, edits the handle / display name / bio / public toggle, checks handle
/// availability, and saves a partial update. Mirrors the other @MainActor
/// @Observable stores.
@MainActor
@Observable
final class VerifiedStore {

    enum Phase: Equatable {
        case idle
        case loading
        case ready
        case failed(String)
    }

    /// Live availability state for the handle field.
    enum HandleCheck: Equatable {
        case idle          // unchanged or empty — nothing to show
        case checking
        case ok
        case taken(String)
        case invalid(String)
    }

    static let maxDisplayName = 60
    static let maxBio = 280

    private let service: VerifiedProviding

    var phase: Phase = .idle

    // Saved state (server truth).
    private(set) var original: VerifiedProfile?
    private(set) var stats: VerifiedStats?

    // Editable drafts.
    var handleDraft = ""
    var displayNameDraft = ""
    var bioDraft = ""
    var enabled = false
    var showListings = false

    var handleCheck: HandleCheck = .idle
    var isSaving = false
    var saveError: String?

    init(service: VerifiedProviding = VerifiedService()) {
        self.service = service
    }

    // MARK: - Derived

    /// Public profile link for the SAVED handle, e.g.
    /// https://gradethread.com/verified/abc. Nil until a handle is claimed.
    var publicProfileURL: URL? {
        guard let handle = original?.handle, !handle.isEmpty else { return nil }
        return URL(string: "\(CertificateLink.siteOrigin.absoluteString)/verified/\(handle)")
    }

    /// The handle that would result from saving (draft if set, else current).
    private var resultingHandle: String {
        let normalized = VerifiedHandle.normalize(handleDraft)
        return normalized.isEmpty ? (original?.handle ?? "") : normalized
    }

    /// Local validation message for the current handle draft (nil if fine/empty).
    var handleLocalError: String? {
        let normalized = VerifiedHandle.normalize(handleDraft)
        guard !normalized.isEmpty else { return nil }
        return VerifiedHandle.validationError(normalized)
    }

    /// True when the public toggle is on but no handle is/would be set.
    var needsHandleToEnable: Bool {
        enabled && resultingHandle.isEmpty
    }

    /// The partial update to send, or nil when nothing changed.
    func pendingUpdate() -> VerifiedProfileUpdate? {
        var update = VerifiedProfileUpdate()
        var changed = false

        let normalized = VerifiedHandle.normalize(handleDraft)
        if !normalized.isEmpty, normalized != (original?.handle ?? "") {
            update.handle = normalized
            changed = true
        }
        let dn = displayNameDraft.trimmed
        if dn != (original?.displayName ?? "") {
            update.displayName = dn
            changed = true
        }
        let bio = bioDraft.trimmed
        if bio != (original?.bio ?? "") {
            update.bio = bio
            changed = true
        }
        if enabled != (original?.enabled ?? false) {
            update.enabled = enabled
            changed = true
        }
        if showListings != (original?.showListings ?? false) {
            update.showListings = showListings
            changed = true
        }
        return changed ? update : nil
    }

    var hasChanges: Bool { pendingUpdate() != nil }

    /// US-1225: the bio/display-name counters turn red when over the limit, but
    /// `canSave` never checked length — so the server truncated and overwrote the
    /// draft (silent content loss). Make over-limit a real block. Uses the same
    /// trimmed length the counters / `pendingUpdate` use.
    var isDisplayNameOverLimit: Bool { displayNameDraft.count > Self.maxDisplayName }
    var isBioOverLimit: Bool { bioDraft.count > Self.maxBio }

    var canSave: Bool {
        guard !isSaving, hasChanges, !needsHandleToEnable else { return false }
        if handleLocalError != nil { return false }
        if isDisplayNameOverLimit || isBioOverLimit { return false }
        switch handleCheck {
        case .checking, .taken, .invalid: return false
        case .idle, .ok: return true
        }
    }

    // MARK: - Actions

    func load() async {
        phase = .loading
        do {
            let res = try await service.profile()
            apply(res.profile)
            stats = res.stats
            phase = .ready
        } catch {
            phase = .failed(message(error))
        }
    }

    /// Validate the handle locally, then (if changed + valid) check availability.
    func checkHandleAvailability() async {
        let normalized = VerifiedHandle.normalize(handleDraft)
        if normalized.isEmpty || normalized == (original?.handle ?? "") {
            handleCheck = .idle
            return
        }
        if let err = VerifiedHandle.validationError(normalized) {
            handleCheck = .invalid(err)
            return
        }
        handleCheck = .checking
        do {
            let result = try await service.checkHandle(normalized)
            // Ignore if the draft moved on while we were checking.
            guard VerifiedHandle.normalize(handleDraft) == normalized else { return }
            handleCheck = result.available
                ? .ok
                : .taken(result.reason ?? "That handle is already taken.")
        } catch {
            // Network hiccup shouldn't block saving — the server re-validates.
            handleCheck = .idle
        }
    }

    /// Persist the pending changes. Returns success.
    @discardableResult
    func save() async -> Bool {
        guard let update = pendingUpdate() else { return false }
        if needsHandleToEnable {
            saveError = "Claim a handle before making your profile public."
            return false
        }
        isSaving = true
        saveError = nil
        defer { isSaving = false }
        do {
            let saved = try await service.update(update)
            apply(saved)
            handleCheck = .idle
            return true
        } catch {
            saveError = message(error)
            return false
        }
    }

    // MARK: - Helpers

    private func apply(_ profile: VerifiedProfile) {
        original = profile
        handleDraft = profile.handle ?? ""
        displayNameDraft = profile.displayName ?? ""
        bioDraft = profile.bio ?? ""
        enabled = profile.enabled
        showListings = profile.showListings
    }

    private func message(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
