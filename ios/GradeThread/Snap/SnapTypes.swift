import Foundation

/// Response from `POST /api/grade/snap` (Snap-to-Value, US-612/613).
/// Decoded with `.convertFromSnakeCase`, so `overall_score` → `overallScore`
/// etc.; the `value` object's keys are already camelCase and pass through.
struct SnapResponse: Decodable {
    let grade: SnapGrade
    let value: SnapValue?
    let disclaimer: String
}

struct SnapGrade: Decodable {
    let overallScore: Double
    let gradeTier: String
    let confidence: Double
}

struct SnapValue: Decodable {
    let lowCents: Int?
    let medianCents: Int?
    let highCents: Int?
    let sampleSize: Int
    let confidence: Double
    let sufficient: Bool
    let currency: String
}
