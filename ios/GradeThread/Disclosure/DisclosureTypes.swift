import Foundation

// Defect-disclosure wire models. Mirror the web contract in
// `src/hooks/use-disclosure.ts` and the edge service in
// `services/edge-functions/src/routes/flipdesk-disclosure.ts`. Decoded through
// `EdgeAPI`'s shared decoder (snake_case → camelCase), so server columns map to
// the camelCase properties below automatically.

/// `GET /api/flipdesk/disclosure/item/:itemId`
struct DisclosureData: Decodable, Equatable {
    let graded: Bool
    let item: DisclosureItem?
    let grade: DisclosureGrade?
    let disclosure: DisclosureText?
    let photos: [DisclosurePhoto]?
}

struct DisclosureItem: Decodable, Equatable {
    let id: String
    let title: String?
    let brand: String?
}

struct DisclosureGrade: Decodable, Equatable {
    let overallScore: Double?
    let gradeTier: String?
    let certificateId: String?
}

struct DisclosureText: Decodable, Equatable {
    let plain: String?
    let markdown: String?
    let html: String?
    let defectCount: Int?
    let hasDefects: Bool?
    let styleFeatures: [String]?
}

/// One graded photo with its defect callouts.
struct DisclosurePhoto: Decodable, Equatable, Identifiable {
    let imageType: String
    let url: String
    let annotations: [PhotoAnnotation]

    // image_type repeats across a submission's photos only if the same role was
    // shot twice; combine with the URL for a stable identity.
    var id: String { imageType + "|" + url }
}

/// A numbered defect callout. `bbox` is normalized `[x, y, w, h]` in 0...1, or
/// nil when the defect couldn't be localized (legend-only).
struct PhotoAnnotation: Decodable, Equatable, Identifiable {
    let n: Int
    let issue: String
    let severity: String
    let location: String?
    let bbox: [Double]?

    var id: Int { n }
    var isLocalized: Bool { (bbox?.count ?? 0) == 4 }
}

/// `POST /api/flipdesk/disclosure/item/:itemId/annotated-photo`
struct SaveAnnotatedResponse: Decodable, Equatable {
    let ok: Bool
    let photoId: String?
    let photoUrl: String?
}

/// `POST /api/flipdesk/disclosure/item/:itemId/apply-to-listing`
struct ApplyDisclosureResponse: Decodable, Equatable {
    let applied: Bool
    let alreadyPresent: Bool?
}
