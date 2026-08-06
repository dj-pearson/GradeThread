import SwiftUI

/// US-1897 (AC5): iOS surfaces for the Listing Quality Score.
///
/// ``QualityScoreChip`` is the compact number for a list row; ``QualityScoreCard``
/// is the full breakdown shown in the publish dialog. Both render what the
/// server sent — the weights are never recomputed here (AC5 forbids it), so the
/// number on a drafts row and the number in the composer are the same number.

// MARK: - Band colour

extension QualityScoreBand {
    /// Brand colour per band. `blocked` is red and stands apart from `poor` on
    /// purpose: the server caps a blocked listing at 40 so it sorts with the
    /// wreckage, and painting it the same amber as a weak-but-listable listing
    /// would undo that distinction the moment a seller looks at the screen.
    var tint: Color {
        switch self {
        case .blocked: return .brandRed
        case .good: return .brandEmerald
        case .fair: return .brandAmber
        case .poor: return .brandAmber
        }
    }
}

// MARK: - Chip

/// The compact score for a list row. `nil` renders an em dash, never a zero:
/// "never scored" and "scored zero" are different facts, and a confident 0
/// would also sort an unscored draft in with the genuinely worst.
struct QualityScoreChip: View {
    let summary: QualityScoreSummary?

    var body: some View {
        if let summary {
            Text(summary.blocked ? "Can\u{2019}t list" : "\(summary.score)")
                .font(.caption2.weight(.semibold))
                .monospacedDigit()
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .background(summary.band.tint.opacity(0.18))
                .foregroundStyle(summary.band.tint)
                .clipShape(Capsule())
                .accessibilityLabel(
                    summary.blocked
                        ? "Cannot be listed"
                        : "Listing quality \(summary.score) out of 100"
                )
        } else {
            Text("\u{2014}")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .accessibilityLabel("Listing quality not scored yet")
        }
    }
}

// MARK: - Full breakdown

/// The score plus every component, each naming the surface that fixes it.
struct QualityScoreCard: View {
    let score: ListingQualityScore

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if score.blocked, let reason = score.blockingReasons.first {
                Text("This listing can\u{2019}t go live yet: \(reason)")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Color.brandRed)
            }
            ForEach(score.components) { component in
                componentRow(component)
            }
            if score.isPartial {
                // Admit a partial assessment rather than passing it off as a
                // full one — a signal we could not read (typically an unsynced
                // business policy) is excluded from the maths server-side.
                Text("Scored on \(score.weightCounted) of 100 points \u{2014} some checks couldn\u{2019}t be read.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("Listing quality")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Spacer()
            if score.blocked {
                Text("Can\u{2019}t list")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(Color.brandRed)
            } else {
                Text("\(score.score)/100")
                    .font(.caption.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(score.band.tint)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            score.blocked
                ? "Listing quality: cannot be listed"
                : "Listing quality \(score.score) out of 100"
        )
    }

    @ViewBuilder
    private func componentRow(_ c: QualityComponent) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Circle()
                .fill(Self.statusTint(c.status))
                .frame(width: 6, height: 6)
                .padding(.top, 5)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    Text(c.label)
                        .font(.caption.weight(.medium))
                    Text(c.pointsText)
                        .font(.caption2)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                if !c.detail.isEmpty {
                    Text(c.detail)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                // AC5: each component NAMES its fix surface. The dialog cannot
                // navigate away mid-publish, so it says where to go rather than
                // offering a button that would abandon the composer's edits.
                if c.status != .ok, c.status != .unknown, !c.fixSurface.isEmpty {
                    Text("Fix in \(c.fixSurface)")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(Color.brandNavy)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// Grey for `unknown`, deliberately: an unreadable signal is excluded from
    /// the score server-side, so it must not look like a failure here either.
    private static func statusTint(_ status: QualityComponent.Status) -> Color {
        switch status {
        case .ok: return .brandEmerald
        case .warn: return .brandAmber
        case .fix: return .brandRed
        case .unknown: return .secondary
        }
    }
}
