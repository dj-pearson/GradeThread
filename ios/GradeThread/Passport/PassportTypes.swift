import Foundation

/// PII-free passport timeline as returned by the public edge endpoint
/// `GET /api/passport/:slug` (services/edge-functions/src/routes/passport.ts).
/// The edge already sanitizes payloads and resolves actors to pseudonymous
/// labels only — iOS renders what it is given and never reaches for identity.
///
/// Decoded with ``JSONDecoder/iso8601`` (the EdgeAPI decoder), so snake_case
/// keys arrive camelCased here. Timestamps are kept as raw ISO strings (the
/// edge emits fractional seconds, which the default `.iso8601` date strategy
/// rejects) and formatted at the display boundary — mirroring the web page.
struct PassportTimeline: Decodable, Equatable {
    let slug: String
    let skuClass: [String: PassportJSONValue]
    let status: String
    let createdAt: String
    /// PII-free origin-seller Verified badge (null unless the seller opted in).
    let originVerifiedSeller: PassportVerifiedSeller?
    let events: [PassportEvent]

    private enum CodingKeys: String, CodingKey {
        case slug, skuClass, status, createdAt, originVerifiedSeller, events
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        slug = try c.decode(String.self, forKey: .slug)
        skuClass = (try? c.decode([String: PassportJSONValue].self, forKey: .skuClass)) ?? [:]
        status = (try? c.decode(String.self, forKey: .status)) ?? "active"
        createdAt = (try? c.decode(String.self, forKey: .createdAt)) ?? ""
        originVerifiedSeller = try? c.decodeIfPresent(PassportVerifiedSeller.self, forKey: .originVerifiedSeller)
        events = (try? c.decode([PassportEvent].self, forKey: .events)) ?? []
    }

    /// Test/preview constructor.
    init(
        slug: String,
        skuClass: [String: PassportJSONValue] = [:],
        status: String = "active",
        createdAt: String = "",
        originVerifiedSeller: PassportVerifiedSeller? = nil,
        events: [PassportEvent] = []
    ) {
        self.slug = slug
        self.skuClass = skuClass
        self.status = status
        self.createdAt = createdAt
        self.originVerifiedSeller = originVerifiedSeller
        self.events = events
    }
}

/// One hop on the provenance chain.
struct PassportEvent: Decodable, Equatable, Identifiable {
    let eventType: String
    let confidence: String
    /// Pseudonymous actor label (e.g. "Seller A"), or nil for an actor-less hop.
    let actor: String?
    /// The actor's PUBLIC Verified identity, present ONLY when they opted in for
    /// this hop. nil (the default) keeps the actor pseudonymous.
    let actorRevealed: PassportVerifiedSeller?
    let source: String?
    let payload: PassportEventPayload
    let createdAt: String

    /// Stable identity for `ForEach` (the ledger is append-only, so type+time+
    /// actor is unique enough; index disambiguates same-instant duplicates).
    var id: String { "\(eventType)|\(createdAt)|\(actor ?? "")" }

    private enum CodingKeys: String, CodingKey {
        case eventType, confidence, actor, actorRevealed, source, payload, createdAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        eventType = (try? c.decode(String.self, forKey: .eventType)) ?? "unknown"
        confidence = (try? c.decode(String.self, forKey: .confidence)) ?? "unknown"
        actor = try? c.decodeIfPresent(String.self, forKey: .actor)
        actorRevealed = try? c.decodeIfPresent(PassportVerifiedSeller.self, forKey: .actorRevealed)
        source = try? c.decodeIfPresent(String.self, forKey: .source)
        payload = (try? c.decode(PassportEventPayload.self, forKey: .payload)) ?? PassportEventPayload()
        createdAt = (try? c.decode(String.self, forKey: .createdAt)) ?? ""
    }

    init(
        eventType: String,
        confidence: String,
        actor: String? = nil,
        actorRevealed: PassportVerifiedSeller? = nil,
        source: String? = nil,
        payload: PassportEventPayload = PassportEventPayload(),
        createdAt: String = ""
    ) {
        self.eventType = eventType
        self.confidence = confidence
        self.actor = actor
        self.actorRevealed = actorRevealed
        self.source = source
        self.payload = payload
        self.createdAt = createdAt
    }
}

/// The subset of a (PII-free) event payload iOS surfaces. All optional — a
/// `graded` event carries the grade detail + a public certificate handle; other
/// event types carry none of these (the keys simply decode to nil).
struct PassportEventPayload: Decodable, Equatable {
    let overallScore: Double?
    let gradeTier: String?
    let certificate: String?

    init(overallScore: Double? = nil, gradeTier: String? = nil, certificate: String? = nil) {
        self.overallScore = overallScore
        self.gradeTier = gradeTier
        self.certificate = certificate
    }
}

/// A public, opt-in Verified profile (handle + display name only — never a user
/// id or email). Used for both the origin seller badge and a per-hop reveal.
struct PassportVerifiedSeller: Decodable, Equatable {
    let handle: String
    let displayName: String?
}

/// A minimal JSON value so `sku_class` (a free-form descriptor) decodes without
/// constraining its shape. Only the string-bearing fields are read for display.
enum PassportJSONValue: Decodable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: PassportJSONValue])
    case array([PassportJSONValue])
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let v = try? c.decode(Bool.self) {
            self = .bool(v)
        } else if let v = try? c.decode(Double.self) {
            self = .number(v)
        } else if let v = try? c.decode(String.self) {
            self = .string(v)
        } else if let v = try? c.decode([String: PassportJSONValue].self) {
            self = .object(v)
        } else if let v = try? c.decode([PassportJSONValue].self) {
            self = .array(v)
        } else {
            self = .null
        }
    }

    /// The string value if this is a non-empty string, else nil.
    var stringValue: String? {
        if case let .string(s) = self, !s.trimmingCharacters(in: .whitespaces).isEmpty {
            return s
        }
        return nil
    }
}

// MARK: - Presentation helpers (pure)

extension PassportEvent {
    /// Human label + SF Symbol per event type. Mirrors the web `EVENT_META`
    /// map; the set tracks the `garment_event_type` enum (00256).
    var presentation: (label: String, symbol: String) {
        switch eventType {
        case "graded": return ("Condition graded", "checkmark.seal.fill")
        case "listed": return ("Listed for sale", "tag.fill")
        case "sold": return ("Sold", "bag.fill")
        case "ownership_transfer": return ("Ownership transferred", "arrow.left.arrow.right")
        case "fingerprinted": return ("Fingerprinted", "viewfinder")
        default: return (PassportFormat.titleCase(eventType), "clock.arrow.circlepath")
        }
    }
}

/// Small pure formatters shared by the passport view.
enum PassportFormat {
    /// "ownership_transfer" / "very-good" → "Ownership Transfer" / "Very Good".
    static func titleCase(_ value: String) -> String {
        value
            .split(whereSeparator: { $0 == "-" || $0 == "_" })
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    /// A human garment name from the PII-free `sku_class` descriptor. The
    /// EdgeAPI decoder camelCases nested keys (`garment_type` → `garmentType`),
    /// so look up both forms to stay robust to the transport.
    static func garmentName(from sku: [String: PassportJSONValue]) -> String {
        let brand = sku["brand"]?.stringValue
        let rawType = (sku["garmentType"] ?? sku["garment_type"])?.stringValue
        let type = rawType.map { titleCase($0) }
        let parts = [brand, type].compactMap { $0 }
        return parts.isEmpty ? "Graded garment" : parts.joined(separator: " ")
    }

    /// ISO timestamp → "June 20, 2026" (falls back to the raw string).
    static func longDate(_ iso: String) -> String {
        guard !iso.isEmpty else { return "" }
        let parsers: [ISO8601DateFormatter] = {
            let withFraction = ISO8601DateFormatter()
            withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let plain = ISO8601DateFormatter()
            plain.formatOptions = [.withInternetDateTime]
            return [withFraction, plain]
        }()
        for parser in parsers {
            if let date = parser.date(from: iso) {
                let out = DateFormatter()
                out.dateStyle = .long
                out.timeStyle = .none
                return out.string(from: date)
            }
        }
        return iso
    }
}
