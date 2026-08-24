import XCTest
@testable import GradeThread

/// Decoding the eBay aspects spec (bare decoder, eBay camelCase) + flattening to
/// `AspectSpec`, and the AI extract-aspects response.
final class EbayAspectsDecodeTests: XCTestCase {

    func test_parsesAspectSpec_usageModeCardinality() throws {
        let json = #"""
        {
          "categoryName": "Athletic Shoes",
          "cached": true,
          "aspects": { "aspects": [
            { "localizedAspectName": "Brand",
              "aspectConstraint": { "aspectMode":"FREE_TEXT","aspectRequired":true,"aspectUsage":"REQUIRED","itemToAspectCardinality":"SINGLE" } },
            { "localizedAspectName": "US Shoe Size",
              "aspectConstraint": { "aspectMode":"SELECTION_ONLY","aspectRequired":false,"aspectUsage":"RECOMMENDED","itemToAspectCardinality":"SINGLE" },
              "aspectValues": [ {"localizedValue":"9"}, {"localizedValue":"10"} ] },
            { "localizedAspectName": "Features",
              "aspectConstraint": { "aspectMode":"SELECTION_ONLY","aspectUsage":"OPTIONAL","itemToAspectCardinality":"MULTI" },
              "aspectValues": [ {"localizedValue":"Waterproof"}, {"localizedValue":"Breathable"} ] }
          ]}
        }
        """#
        let res = try JSONDecoder().decode(CategoryAspectsResponse.self, from: Data(json.utf8))
        XCTAssertEqual(res.categoryName, "Athletic Shoes")
        let specs = AspectSpec.parse(res)
        XCTAssertEqual(specs.count, 3)

        XCTAssertEqual(specs[0].name, "Brand")
        XCTAssertEqual(specs[0].usage, .required)
        XCTAssertFalse(specs[0].selectionOnly)
        XCTAssertFalse(specs[0].multiSelect)
        XCTAssertTrue(specs[0].allowedValues.isEmpty)

        XCTAssertEqual(specs[1].usage, .recommended)
        XCTAssertTrue(specs[1].selectionOnly)
        XCTAssertEqual(specs[1].allowedValues, ["9", "10"])

        XCTAssertEqual(specs[2].usage, .optional)
        XCTAssertTrue(specs[2].multiSelect)
    }

    // US-2839: the column -> aspect pairing the item page renders from.
    func test_decodesColumnBackedAspectsMap() throws {
        let json = #"""
        {
          "aspects": { "aspects": [] },
          "columnBackedAspectNames": ["Style", "US Shoe Size"],
          "columnBackedAspects": { "style": "Style", "size": "US Shoe Size" }
        }
        """#
        let res = try JSONDecoder().decode(CategoryAspectsResponse.self, from: Data(json.utf8))
        XCTAssertEqual(res.columnAspectNames, ["style": "Style", "size": "US Shoe Size"])
        XCTAssertEqual(res.columnBackedNames, ["Style", "US Shoe Size"])
    }

    // An edge build that predates the key must still decode -- a non-Optional
    // stored property would fail the WHOLE response, taking the specifics
    // editor down with it (the US-821 trap).
    func test_missingColumnBackedAspects_decodesToEmpty() throws {
        let json = #"{"aspects":{"aspects":[]}}"#
        let res = try JSONDecoder().decode(CategoryAspectsResponse.self, from: Data(json.utf8))
        XCTAssertTrue(res.columnAspectNames.isEmpty)
        XCTAssertTrue(res.columnBackedNames.isEmpty)
    }

    func test_required_viaUsageStringWhenFlagAbsent() throws {
        let json = #"{"aspects":{"aspects":[{"localizedAspectName":"Type","aspectConstraint":{"aspectUsage":"REQUIRED"}}]}}"#
        let res = try JSONDecoder().decode(CategoryAspectsResponse.self, from: Data(json.utf8))
        XCTAssertEqual(AspectSpec.parse(res).first?.usage, .required)
    }

    func test_emptyOrMissingAspects_yieldsNoSpecs() throws {
        let res = try JSONDecoder().decode(CategoryAspectsResponse.self, from: Data(#"{"categoryName":"X"}"#.utf8))
        XCTAssertTrue(AspectSpec.parse(res).isEmpty)
    }

    func test_decodesExtractAspects() throws {
        let json = #"""
        {"category_id":"15709","suggestions":{
          "Brand":{"values":["Nike"],"confidence":0.94,"source":"vision"},
          "Color":{"values":["Black","White"],"confidence":0.55,"source":"text"}
        }}
        """#
        let res = try JSONDecoder().decode(ExtractAspectsResponse.self, from: Data(json.utf8))
        XCTAssertEqual(res.categoryId, "15709")
        XCTAssertEqual(res.suggestions["Brand"]?.values, ["Nike"])
        XCTAssertEqual(res.suggestions["Color"]?.confidence ?? 0, 0.55, accuracy: 0.001)
    }
}
