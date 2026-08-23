import Foundation
import UIKit

/// US-2016 — the paid CONSUMER grading path on iOS: photos to
/// `POST /api/grade/submit`.
///
/// THE DECISION THIS IMPLEMENTS. AC1 asked whether the consumer certified path
/// belongs on the phone at all; the owner answered yes on 2026-08-19. Web has
/// always had both pipelines (consumer/certified and FlipDesk/reseller) and iOS
/// had only the reseller one, so the client people actually photograph clothes
/// with could not buy a certified grade.
///
/// DELIBERATELY MODELLED ON ``VideoGradeUploader`` RATHER THAN ON THE FLIPDESK
/// SERVICE. The video uploader already posts multipart to this exact endpoint
/// and already decodes its replies, so the field set, the auth, the abstain
/// outcome and the submission-id fallback are proven against the route rather
/// than re-derived from it. What changes is the parts: `images` + `image_types`
/// instead of a clip.
///
/// ⚠ NEVER BOTH. The route refuses photos alongside a clip and the refusal
/// arrives AFTER the upload, so a request carrying each would cost the user a
/// full upload to be told no. ``VideoGradeUploader`` says the same thing from
/// its side; this is the other half of that pair.
enum PhotoGradeContract {
    /// The grading pipeline's own image vocabulary. NOT the FlipDesk one: the
    /// tag shot is `label` here and `tag` there, which is the exact pair
    /// US-2304 found the two requirement lists disagreeing over. The server
    /// maps grading -> FlipDesk in `gradingImageTypeToPhotoType`; this is the
    /// inverse, and it is the direction a client needs.
    static func gradingImageType(for slot: PhotoSlotType) -> String {
        switch slot {
        case .tag: return "label"
        case .tag2: return "label_2"
        default: return slot.rawValue
        }
    }

    /// `REQUIRED_IMAGE_TYPES` in services/edge-functions/src/lib/image-quality.ts,
    /// at severity `block`. A submission missing one of these is charged, runs a
    /// vision call per image, then abstains to needs_photos and refunds - the
    /// money comes back and the AI spend does not, which is what US-2304 was
    /// about. Checking here means the user is told before they pay.
    static let requiredGradingTypes = ["front", "back", "label"]

    /// Which required shots are absent. Order preserved so the message names
    /// them in the order the strip shows them.
    static func missingRequired(from present: [String]) -> [String] {
        let have = Set(present)
        return requiredGradingTypes.filter { !have.contains($0) }
    }

    /// `MAX_IMAGES_PER_SUBMISSION` on the route, which is `IMAGE_TYPES.length`.
    ///
    /// FOURTEEN, and I first wrote twelve from memory - caught by reading the
    /// constant rather than by anything failing, which is the same shape as the
    /// dispute key this week. src/test/consumer-grade-contract.test.ts reads
    /// this number back out of grade.ts so the next wrong guess reddens.
    ///
    /// The route also rejects DUPLICATE types, so the real rule is one of each
    /// kind rather than fourteen photos. The cap exists because the pipeline
    /// issues one Claude Vision call PER image while billing a single grade, so
    /// an uncapped count is a direct AI-cost multiplier.
    static let maxImages = 14

    /// US-2802: where a photo came from.
    ///
    /// ⚠ NOT the video tier's string. ``VideoGradingContract`` says
    /// `in_app_recorder` for a walk-around clip and this says
    /// `in_app_camera`; the server keeps them apart because they are
    /// different claims about different evidence, and sending one where the
    /// other belongs earns nothing rather than failing. The Android sabotage
    /// made exactly that swap and every Kotlin test stayed green, so the
    /// value is pinned against the server's own literal in
    /// `src/test/native-photo-grade-contract-parity.test.ts` rather than
    /// restated in a test here.
    static let captureSourceInAppCamera = "in_app_camera"
    static let captureSourceLibrary = "library"

    static let liveCaptureOptInField = "live_capture_opt_in"
    static let captureSourcesField = "capture_sources"

    /// Whether this set of origins earns Live Capture.
    ///
    /// DERIVED, never a checkbox: the claim is that the app watched every
    /// photo being taken, which is a fact about how they were shot rather
    /// than a preference. Deriving it also makes the one combination
    /// `routes/grade.ts` rejects outright unsendable - opted in with a
    /// library photo in the set.
    ///
    /// The emptiness check is not redundant. `allSatisfy` is vacuously true
    /// on an empty collection, so without it a submission with no photos at
    /// all would claim the strongest provenance tier there is.
    static func qualifiesForLiveCapture(_ sources: [String]) -> Bool {
        !sources.isEmpty && sources.allSatisfy { $0 == captureSourceInAppCamera }
    }
}

struct PhotoGradeRequest: Equatable {
    var garmentType: String
    var garmentCategory: String
    var title: String
    var tier: String
    var brand: String?
    var description: String?
    /// The seller's inventory item this grade belongs to. Without it the
    /// finished certificate attaches to nothing and has to be linked by hand.
    var inventoryItemId: String?
    /// A buyer's closet item, for the consumer journey.
    var closetItemId: String?
}

/// One photo, already downscaled and JPEG-encoded.
struct PhotoGradeImage: Equatable {
    /// GRADING vocabulary (front / back / label / detail / ...), not the
    /// FlipDesk one. Build it with ``PhotoGradeContract/gradingImageType(for:)``.
    let gradingType: String
    let jpeg: Data
    /// US-2802: where this photo came from.
    let captureSource: String

    /// The default FAILS CLOSED. An origin nobody recorded must not be
    /// reported as live - the opposite default hands out the strongest
    /// provenance badge on a bookkeeping slip, and every existing caller
    /// (including the tests) picks it up without saying anything.
    ///
    /// Written out rather than left to the memberwise initializer: a `let`
    /// property with an inline default is OMITTED from the synthesised
    /// initializer entirely, so callers could not have set it at all.
    init(
        gradingType: String,
        jpeg: Data,
        captureSource: String = PhotoGradeContract.captureSourceLibrary
    ) {
        self.gradingType = gradingType
        self.jpeg = jpeg
        self.captureSource = captureSource
    }
}

/// What the SUBMIT call came back with.
///
/// One case, deliberately. My first draft carried an abstain here by copying
/// ``VideoGradeOutcome``, and that is a video-path shape: the clip route decides
/// at submit time whether every required view was shown, while the photo route's
/// image-quality gate runs later inside the grading pipeline. So a photo submit
/// can only report that a submission exists and whether it was already paid;
/// `needs_photos` arrives on ``PhotoGradeStatus``.
enum PhotoGradeOutcome: Equatable {
    case submitted(submissionId: String, paid: Bool)
}

enum PhotoGradeError: LocalizedError, Equatable {
    case missingRequired([String])
    case tooManyImages(Int)
    case noImages

    var errorDescription: String? {
        switch self {
        case let .missingRequired(types):
            let names = types.map(PhotoGradeCopy.friendlyName).joined(separator: ", ")
            return "Add the \(names) photo before grading. The grader needs those to score condition."
        case let .tooManyImages(count):
            return "That's \(count) photos. A grade takes at most \(PhotoGradeContract.maxImages)."
        case .noImages:
            return "Add photos before grading."
        }
    }
}

enum PhotoGradeCopy {
    /// The grader's vocabulary is not the seller's. `label` is the word the
    /// route uses and "tag" is the word on the capture strip, so an error that
    /// says label sends someone looking for a control that does not exist.
    static func friendlyName(_ gradingType: String) -> String {
        switch gradingType {
        case "label": return "tag"
        case "label_2": return "second tag"
        default: return gradingType
        }
    }
}

/// The non-file fields, in one place so a test can read them without building a
/// multipart body. Mirrors ``VideoGradeUploader/fields(for:)`` and differs from
/// it in exactly one way: no video field, ever.
enum PhotoGradeFields {
    static func fields(for request: PhotoGradeRequest) -> [(String, String)] {
        var out: [(String, String)] = [
            ("garment_type", request.garmentType),
            ("garment_category", request.garmentCategory),
            ("title", request.title),
            ("tier", request.tier),
            // Sent explicitly false rather than omitted, for the reason the
            // video uploader gives: the server re-checks either way, and
            // leaving a request's meaning to a default lets that default change
            // without this client knowing.
            ("verified_capture_opt_in", "false"),
            ("authenticity_addon", "false"),
        ]
        if let brand = request.brand, !brand.isEmpty { out.append(("brand", brand)) }
        if let description = request.description, !description.isEmpty {
            out.append(("description", description))
        }
        if let closetItemId = request.closetItemId, !closetItemId.isEmpty {
            out.append(("closet_item_id", closetItemId))
        }
        if let inventoryItemId = request.inventoryItemId, !inventoryItemId.isEmpty {
            out.append(("inventory_item_id", inventoryItemId))
        }
        return out
    }

    /// US-2802: the live-capture opt-in, or nothing.
    ///
    /// Separate from ``fields(for:)`` because it is a fact about the IMAGES
    /// rather than about the request, and kept out of the multipart writer so
    /// a test can read it without building a body - which is the whole reason
    /// ``fields(for:)`` exists in this shape.
    static func liveCaptureFields(for images: [PhotoGradeImage]) -> [(String, String)] {
        guard PhotoGradeContract.qualifiesForLiveCapture(images.map(\.captureSource))
        else { return [] }
        return [(PhotoGradeContract.liveCaptureOptInField, "true")]
    }

    /// Refuse before uploading. Every one of these is something the route would
    /// answer with a 400 or an abstain after the whole body has gone up, which
    /// on a phone signal is the slowest possible way to be told no.
    static func validate(_ images: [PhotoGradeImage]) -> PhotoGradeError? {
        if images.isEmpty { return .noImages }
        if images.count > PhotoGradeContract.maxImages {
            return .tooManyImages(images.count)
        }
        let missing = PhotoGradeContract.missingRequired(from: images.map(\.gradingType))
        if !missing.isEmpty { return .missingRequired(missing) }
        return nil
    }
}
