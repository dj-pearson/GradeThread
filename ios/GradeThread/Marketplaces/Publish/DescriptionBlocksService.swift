import Foundation
import GradeThreadCore

/// US-2964 - the four description-block routes (US-2958), from iOS.
///
///   GET  /:listingId/blocks      load, converting a legacy description on the way
///   POST /preview                render an unsaved array
///   POST /:listingId/save        persist blocks + the string they render to
///   POST /:listingId/regenerate  rewrite one AI block
///
/// CONVERT-ON-OPEN IS NOT A WRITE. The GET returns the parsed blocks AND the
/// string they render to; that string is used as the first preview VERBATIM
/// rather than being re-requested, which is what makes "the preview equals the
/// stored description byte for byte before any edit" true rather than nearly
/// true. Re-rendering it would also spend a round trip to be told the same
/// thing.
///
/// NOTHING here renders a description. The renderer is edge-only by design, so
/// the only string this app ever shows a seller is one the server produced -
/// which is also why a listing edited on a phone and opened on the web shows the
/// same bytes.
///
/// The regenerate call runs a model server-side and answers nothing until the
/// copy is written, so it goes on ``EdgeAPI/aiShared`` (120s idle) rather than
/// the 20s shared session. On the short session it would fail every time while
/// the server finished the work and billed the seller's quota for it.
enum DescriptionBlocksService {

    private static let base = "/api/flipdesk/description"

    // MARK: - Wire types

    struct BlocksResponse: Decodable {
        let blocks: [DescriptionBlock]
        /// The exact bytes the current array renders to. Adopt verbatim.
        let preview: String
        /// True when these rows came from parsing a legacy description string,
        /// and nothing is stored yet.
        let converted: Bool

        private enum CodingKeys: String, CodingKey {
            case blocks, preview, converted
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            blocks = try c.decode([DescriptionBlock].self, forKey: .blocks)
            preview = try c.decodeIfPresent(String.self, forKey: .preview) ?? ""
            converted = try c.decodeIfPresent(Bool.self, forKey: .converted) ?? false
        }
    }

    /// The shape both /save and /regenerate answer in: the array the server just
    /// rendered, and the string it rendered to.
    struct SavedResponse: Decodable {
        let blocks: [DescriptionBlock]
        let description: String

        private enum CodingKeys: String, CodingKey {
            case blocks, description
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            blocks = try c.decode([DescriptionBlock].self, forKey: .blocks)
            description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        }
    }

    private struct PreviewResponse: Decodable {
        let preview: String
    }

    private struct PreviewRequest: Encodable {
        let listingId: String
        let blocks: [DescriptionBlock]
        let unit: String
    }

    private struct SaveRequest: Encodable {
        let blocks: [DescriptionBlock]
        let unit: String
    }

    private struct RegenerateRequest: Encodable {
        let block: String
        let unit: String
    }

    // MARK: - Calls

    /// The listing's blocks, plus the string they render to.
    static func load(
        listingId: String,
        unit: MeasurementUnit,
        api: EdgeAPI = .shared
    ) async throws -> BlocksResponse {
        try await api.getJSON(
            "\(base)/\(listingId)/blocks",
            query: [URLQueryItem(name: "unit", value: wireUnit(unit))]
        )
    }

    /// Render an unsaved array. Read-only server-side - nothing is persisted, so
    /// a seller who backs out of a screen has changed nothing.
    static func preview(
        listingId: String,
        blocks: [DescriptionBlock],
        unit: MeasurementUnit,
        api: EdgeAPI = .shared
    ) async throws -> String {
        let response: PreviewResponse = try await api.postJSON(
            "\(base)/preview",
            body: PreviewRequest(
                listingId: listingId, blocks: blocks, unit: wireUnit(unit)
            )
        )
        return response.preview
    }

    /// Persist the array and the string it renders to, in one update.
    static func save(
        listingId: String,
        blocks: [DescriptionBlock],
        unit: MeasurementUnit,
        api: EdgeAPI = .shared
    ) async throws -> SavedResponse {
        try await api.postJSON(
            "\(base)/\(listingId)/save",
            body: SaveRequest(blocks: blocks, unit: wireUnit(unit))
        )
    }

    /// Rewrite ONE ai block. Every other entry comes back byte-identical, which
    /// is what makes "redo one sentence" not a full rewrite.
    ///
    /// `aiShared`, not `shared`: the server runs a model before it answers.
    static func regenerate(
        listingId: String,
        block: DescriptionBlockKey,
        unit: MeasurementUnit,
        api: EdgeAPI = .aiShared
    ) async throws -> SavedResponse {
        try await api.postJSON(
            "\(base)/\(listingId)/regenerate",
            body: RegenerateRequest(block: block.rawValue, unit: wireUnit(unit))
        )
    }

    /// The seller's standing lines, for the "Add a snippet" menu (US-2961).
    ///
    /// Read straight from `listing_snippets` under RLS rather than through the
    /// edge: it is the caller's own rows and the policy already scopes them, so
    /// a route would add a hop without adding a rule. The web settings page
    /// reads it the same way.
    static func snippets() async -> [ListingSnippet] {
        do {
            let rows: [ListingSnippet] = try await SupabaseShared.client
                .from("listing_snippets")
                .select("id,name")
                .order("sort_order", ascending: true)
                .execute()
                .value
            return rows
        } catch {
            // An empty menu, not an error state. Snippets are an assist; a
            // seller whose list failed to load can still write the description.
            return []
        }
    }

    struct ListingSnippet: Decodable, Identifiable, Sendable {
        let id: String
        let name: String
    }

    /// The column stores "in"/"cm"; the app's preference enum spells them out.
    static func wireUnit(_ unit: MeasurementUnit) -> String {
        unit == .centimeters ? "cm" : "in"
    }
}
