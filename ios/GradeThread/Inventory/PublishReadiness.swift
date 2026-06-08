import Foundation

/// US-683 — "is this item ready to list?" computed from local signals so the
/// canvas and the inventory row can show readiness BEFORE the user opens the
/// publish sheet (where blockers previously only surfaced after a round-trip).
///
/// Pure + value-typed so it's unit-tested and shared by the canvas (full photo
/// list) and the row (primary-photo flag only).
enum PublishReadiness {

    /// Statuses where listing to eBay is a sensible next step.
    static let publishableStatuses: Set<String> = [
        "sourced", "cataloged", "measured", "photographed", "graded", "comped", "drafted",
    ]

    /// Human-readable, ordered list of what's missing before this item can be
    /// listed. Empty == ready.
    static func blockers(
        title: String,
        hasPhotos: Bool,
        targetPrice: Double?,
        status: String
    ) -> [String] {
        var blockers: [String] = []
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed.caseInsensitiveCompare("Untitled item") == .orderedSame {
            blockers.append("Add a title")
        }
        if !hasPhotos {
            blockers.append("Add at least one photo")
        }
        if (targetPrice ?? 0) <= 0 {
            blockers.append("Set a list price")
        }
        return blockers
    }

    static func isPublishable(status: String) -> Bool {
        publishableStatuses.contains(status)
    }

    /// Ready to list: a publishable stage with no outstanding blockers.
    static func isReady(
        title: String,
        hasPhotos: Bool,
        targetPrice: Double?,
        status: String
    ) -> Bool {
        isPublishable(status: status)
            && blockers(title: title, hasPhotos: hasPhotos, targetPrice: targetPrice, status: status).isEmpty
    }
}
