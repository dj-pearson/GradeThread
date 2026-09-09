import Foundation

/// Which section of the Returns & disputes screen a deep link means (US-3266).
///
/// Separate from ``PostSaleView/Tab`` on purpose. That enum's raw values are
/// the segmented-control LABELS, and these raw values are written to disk as
/// part of a cold-launch token, so renaming a segment must not orphan a token
/// a user already has pending.
public enum PostSaleSection: String, Hashable, CaseIterable {
    case returns
    case cancellations
    case disputes
}

/// Navigation value for the Returns & disputes screen. Register with
/// `.navigationDestination(for: PostSaleRoute.self)`, the same way
/// ``NegotiationRoute`` is.
struct PostSaleRoute: Hashable {
    let section: PostSaleSection
}
