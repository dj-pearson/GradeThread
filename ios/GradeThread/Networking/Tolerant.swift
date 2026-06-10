import Foundation

/// US-793: a `Codable` wrapper that decodes a known `String`-raw enum case, or
/// degrades to `.unknown(rawValue)` when the server introduces a value this build
/// doesn't know — instead of failing the WHOLE response decode. Use it as a DTO
/// property type so one new server enum value can never break an old app build:
///
///     struct Batch: Codable { let status: Tolerant<BatchStatus> }
///
/// Render `.unknown` sensibly in the UI (the raw string, or a neutral label).
@frozen
enum Tolerant<Wrapped>: Equatable
where Wrapped: RawRepresentable & Equatable, Wrapped.RawValue == String {
    case known(Wrapped)
    case unknown(String)

    /// The typed case, or `nil` when the server sent an unrecognized value.
    var value: Wrapped? {
        if case let .known(w) = self { return w }
        return nil
    }

    /// The wire string regardless of known/unknown (for display + re-encoding).
    var rawValue: String {
        switch self {
        case let .known(w): return w.rawValue
        case let .unknown(s): return s
        }
    }

    init(_ raw: String) {
        if let w = Wrapped(rawValue: raw) {
            self = .known(w)
        } else {
            self = .unknown(raw)
        }
    }

    /// Convenience equality against the underlying enum: `batch.status == .completed`.
    static func == (lhs: Tolerant<Wrapped>, rhs: Wrapped) -> Bool {
        lhs.value == rhs
    }
}

extension Tolerant: Codable {
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self.init(raw)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}
