import XCTest
@testable import GradeThread

// US-745: the iOS Listing Kit consumes the web platform-fields endpoint, so the
// risk is (a) decoding the server shape correctly and (b) the pure kit helpers
// (per-field value, char-count source, validation partitioning). Both are
// covered here with the SAME decoder EdgeAPI uses (convertFromSnakeCase).

private let SAMPLE_JSON = """
{
  "listing_id": "li_1",
  "variants": [
    {
      "platform": "poshmark",
      "title": "Nike Tech Fleece Hoodie Black Large",
      "description": "Cozy tech fleece in excellent condition.",
      "condition": { "value": "EUC", "label": "Excellent Used Condition" },
      "category": "Men > Tops > Hoodies",
      "categorySource": "seed",
      "categoryDepartment": null,
      "categoryNeedsPick": false,
      "brand": "Nike",
      "color": "Black",
      "size": "L",
      "price": 48,
      "tags": ["#nike", "#techfleece"],
      "confidence": 0.9,
      "validation": {
        "platform": "poshmark",
        "ok": false,
        "issues": [
          { "field": "title", "level": "error", "message": "Title is 60/50 — trim 10" },
          { "field": "brand", "level": "warning", "message": "Brand helps discovery" }
        ]
      },
      "spec": {
        "label": "Poshmark",
        "fields": [
          { "key": "title", "label": "Title", "required": true, "maxLength": 50 },
          { "key": "description", "label": "Description", "required": true, "maxLength": 1500, "multiline": true },
          { "key": "tags", "label": "Tags", "required": false }
        ],
        "maxPhotos": 16,
        "sourceNote": "AI-tailored from your eBay draft — verify before listing."
      }
    }
  ]
}
"""

private func decodeSample() throws -> ListingKitResponse {
    try JSONDecoder.iso8601.decode(ListingKitResponse.self, from: Data(SAMPLE_JSON.utf8))
}

final class ListingKitDecodingTests: XCTestCase {
    func test_decodesServerShape() throws {
        let res = try decodeSample()
        XCTAssertEqual(res.listingId, "li_1")           // listing_id → listingId
        XCTAssertEqual(res.variants.count, 1)

        let v = res.variants[0]
        XCTAssertEqual(v.platform, "poshmark")
        XCTAssertEqual(v.condition?.label, "Excellent Used Condition")
        XCTAssertEqual(v.category, "Men > Tops > Hoodies")
        XCTAssertEqual(v.categoryNeedsPick, false)
        XCTAssertEqual(v.tags, ["#nike", "#techfleece"])
        XCTAssertEqual(v.spec?.label, "Poshmark")
        XCTAssertEqual(v.spec?.fields.first?.maxLength, 50)
        XCTAssertEqual(v.spec?.maxPhotos, 16)
    }

    func test_validationPartitioning() throws {
        let v = try decodeSample().variants[0]
        XCTAssertEqual(v.blockingIssues.count, 1)
        XCTAssertEqual(v.warningIssues.count, 1)
        XCTAssertFalse(v.validation.ok)
        // The over-limit title issue is attached to the title field.
        let titleIssues = v.issues(forField: "title")
        XCTAssertEqual(titleIssues.count, 1)
        XCTAssertTrue(titleIssues.first?.isError ?? false)
    }

    func test_perFieldValueMapping() throws {
        let v = try decodeSample().variants[0]
        XCTAssertEqual(v.value(forField: "title"), "Nike Tech Fleece Hoodie Black Large")
        XCTAssertEqual(v.value(forField: "tags"), "#nike #techfleece")
        XCTAssertEqual(v.value(forField: "condition"), "Excellent Used Condition")
        XCTAssertEqual(v.value(forField: "price"), "48.00")
        // Grailed aliases: brand→designer, category→department.
        XCTAssertEqual(v.value(forField: "designer"), "Nike")
        XCTAssertEqual(v.value(forField: "department"), "Men > Tops > Hoodies")
    }

    func test_copyAllBuildsLabeledBlocks() throws {
        let v = try decodeSample().variants[0]
        let all = v.copyAllText()
        XCTAssertTrue(all.contains("Title:"))
        XCTAssertTrue(all.contains("Description:"))
        XCTAssertTrue(all.contains("Tags:"))
        XCTAssertTrue(all.contains("#nike #techfleece"))
    }
}

private struct FakeKitService: ListingKitProviding {
    let result: Result<ListingKitResponse, Error>
    func platformFields(itemId: String, platforms: [String]) async throws -> ListingKitResponse {
        try result.get()
    }
}

@MainActor
final class ListingKitStoreTests: XCTestCase {
    func test_load_populatesVariantsOnSuccess() async throws {
        let sample = try decodeSample()
        let store = ListingKitStore(
            itemId: "i1",
            itemTitle: "Nike Hoodie",
            service: FakeKitService(result: .success(sample))
        )
        await store.load()
        XCTAssertEqual(store.phase, .ready)
        XCTAssertEqual(store.variants.count, 1)
        XCTAssertEqual(store.variants.first?.platform, "poshmark")
    }

    func test_load_surfacesServerErrorMessage() async {
        let store = ListingKitStore(
            itemId: "i1",
            itemTitle: "Nike Hoodie",
            service: FakeKitService(result: .failure(EdgeAPIError.badRequest(detail: "Item has no eBay draft yet.")))
        )
        await store.load()
        guard case .failed(let message) = store.phase else {
            return XCTFail("expected .failed, got \(store.phase)")
        }
        XCTAssertTrue(message.contains("eBay draft"))
        XCTAssertTrue(store.variants.isEmpty)
    }
}
