import XCTest
@testable import GradeThread

/// Decoding the defect-disclosure payload (snake_case via the EdgeAPI decoder),
/// including localized vs legend-only (null bbox) annotations.
final class DisclosureDecodeTests: XCTestCase {

    func test_decodesDisclosureData_withMixedAnnotations() throws {
        let json = #"""
        {
          "graded": true,
          "item": {"id":"it1","title":"Wool Coat","brand":"Pendleton"},
          "grade": {"overall_score":7.5,"grade_tier":"Excellent","certificate_id":"C1"},
          "disclosure": {"plain":"Minor wear.","markdown":"..","html":"<p>..</p>",
                         "defect_count":2,"has_defects":true,"style_features":["Distressed"]},
          "photos": [
            {"image_type":"front","url":"https://img/front.jpg","annotations":[
               {"n":1,"issue":"Pilling","severity":"minor","location":"left cuff","bbox":[0.1,0.2,0.15,0.1]},
               {"n":2,"issue":"Stain","severity":"major","location":"hem","bbox":null}
            ]}
          ]
        }
        """#
        let d = try JSONDecoder.iso8601.decode(DisclosureData.self, from: Data(json.utf8))
        XCTAssertTrue(d.graded)
        XCTAssertEqual(d.item?.brand, "Pendleton")
        XCTAssertEqual(d.grade?.overallScore, 7.5)
        XCTAssertEqual(d.grade?.gradeTier, "Excellent")
        XCTAssertEqual(d.disclosure?.defectCount, 2)
        XCTAssertEqual(d.disclosure?.styleFeatures, ["Distressed"])

        let photo = try XCTUnwrap(d.photos?.first)
        XCTAssertEqual(photo.imageType, "front")
        XCTAssertEqual(photo.annotations.count, 2)
        XCTAssertTrue(photo.annotations[0].isLocalized)
        XCTAssertEqual(photo.annotations[0].bbox, [0.1, 0.2, 0.15, 0.1])
        XCTAssertFalse(photo.annotations[1].isLocalized) // bbox null → legend-only
    }

    func test_decodesUngraded() throws {
        let d = try JSONDecoder.iso8601.decode(DisclosureData.self, from: Data(#"{"graded":false}"#.utf8))
        XCTAssertFalse(d.graded)
        XCTAssertNil(d.photos)
    }

    func test_decodesSaveAndApplyResponses() throws {
        let s = try JSONDecoder.iso8601.decode(
            SaveAnnotatedResponse.self,
            from: Data(#"{"ok":true,"photo_id":"p1","photo_url":"https://img/p1.png"}"#.utf8)
        )
        XCTAssertTrue(s.ok)
        XCTAssertEqual(s.photoId, "p1")

        let a = try JSONDecoder.iso8601.decode(
            ApplyDisclosureResponse.self,
            from: Data(#"{"applied":true,"already_present":false}"#.utf8)
        )
        XCTAssertTrue(a.applied)
        XCTAssertEqual(a.alreadyPresent, false)
    }
}
