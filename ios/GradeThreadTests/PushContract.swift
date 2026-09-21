import Foundation
import XCTest

/// US-3279: the edge's push contract, read from `contracts/push-contract.json`.
///
/// ⚠ WHY THIS IS NOT A LIST IN A SWIFT FILE ANY MORE. Three bugs in one
/// session came from iOS and the edge each describing this contract in their
/// own file with nothing comparing them: US-3266 (the edge sent seven
/// categories iOS had never heard of, so every tap on a return, case or
/// dispute push went nowhere), US-3268 (three Settings toggles for pushes
/// nothing can send) and US-3274 (five inline buttons the payload could not
/// serve, one of which asked for Face ID before doing nothing). Each had a
/// nearby comment asserting the opposite, written when it was true.
///
/// The artefact is generated from `transactional-push.ts` and a Deno test
/// fails when it is stale, so a category added on the server and not here
/// fails on the iOS side too.
///
/// Loaded from `#filePath` rather than a test bundle for the same reason
/// `MeasureQuarterTurnTests` does: the file lives in the repo, not in the app.
enum PushContract {

    struct Category: Decodable {
        let id: String
        let kind: String
        let sender: String
        let payloadKeys: [String]
    }

    private struct Artifact: Decodable {
        let categories: [Category]
    }

    static let url: URL = {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // GradeThreadTests
            .deletingLastPathComponent() // ios
            .deletingLastPathComponent() // repo root
            .appendingPathComponent("contracts/push-contract.json")
    }()

    /// Every category the edge sends, in the artefact's order.
    static let categories: [Category] = {
        do {
            let data = try Data(contentsOf: url)
            return try JSONDecoder().decode(Artifact.self, from: data).categories
        } catch {
            // An unreadable artefact must FAIL, never read as an empty list:
            // every guard built on it would go vacuously green, which is the
            // one outcome worse than the drift it is here to catch.
            fatalError("contracts/push-contract.json could not be read: \(error)")
        }
    }()

    /// The category identifiers the edge sends.
    static var sentByEdge: [String] { categories.map(\.id) }

    /// What the edge stamps in `data` for one category.
    static func payloadKeys(for category: String) -> Set<String> {
        guard let entry = categories.first(where: { $0.id == category }) else {
            // A category iOS knows and the edge does not send carries nothing,
            // which is what `NotificationCategoryID.payloadKeys` must say too.
            return ["kind"]
        }
        return Set(entry.payloadKeys)
    }
}
