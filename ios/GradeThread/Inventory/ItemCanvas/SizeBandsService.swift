import Foundation

/// US-2920: fetch the expected-size band table for one brand + garment.
///
/// Kept out of `SizeCheck` on purpose: the check itself is pure arithmetic that
/// has to run on every keystroke, and the only reason it needs a network at all
/// is to get the table once. The edge marks the response cacheable for half an
/// hour and it does not depend on the caller, so a stale table is never wrong,
/// only old.
///
/// A failure is NOT an error state. The size check is an assist; when the table
/// cannot be fetched the canvas shows no note and the seller carries on, which
/// is exactly what happens for a brand with no chart on file.
enum SizeBandsService {
    /// Half an hour, matching the endpoint's own Cache-Control.
    static let cacheTTL: TimeInterval = 30 * 60

    static func load(
        brand: String?,
        garment: String?,
        gender: String?,
        api: EdgeAPI = .shared
    ) async -> SizeCheck.BandsResponse {
        let garmentValue = (garment ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !garmentValue.isEmpty else { return .empty }

        var query = [URLQueryItem(name: "garment", value: garmentValue)]
        let brandValue = (brand ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !brandValue.isEmpty {
            query.append(URLQueryItem(name: "brand", value: brandValue))
        }
        let genderValue = (gender ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !genderValue.isEmpty {
            query.append(URLQueryItem(name: "gender", value: genderValue))
        }

        do {
            let response: SizeCheck.BandsResponse = try await api.getJSON(
                "/api/flipdesk/size-bands",
                query: query,
                cacheTTL: cacheTTL
            )
            return response
        } catch {
            return .empty
        }
    }
}
