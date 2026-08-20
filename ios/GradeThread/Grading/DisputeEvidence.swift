import PhotosUI
import SwiftUI
import UIKit

/// US-2688 — evidence photos on an iOS grade dispute.
///
/// Web posts base64 evidence from submission-detail.tsx and Android sends up to
/// `MAX_EVIDENCE = 8`. iOS collected a reason and free text only, which is the
/// weak half of a CONDITION dispute: the argument IS a photograph of the
/// garment, and the one client built around a camera was the one that could not
/// attach one.
///
/// The route already accepts them (`images`), validates each by magic bytes,
/// strips EXIF and GPS, and stores them under the owner's folder (US-276). No
/// protocol work; this is the client half that was never built.
@MainActor
enum DisputeEvidence {
    /// `MAX_DISPUTE_EVIDENCE` in services/edge-functions/src/routes/grade.ts.
    ///
    /// Over the cap the route rejects the WHOLE filing with a 400, so a client
    /// that lets you attach nine loses the reason text with them. Enforced here
    /// rather than trusted to the server for that reason alone.
    static let maxPhotos = 8

    struct Result {
        let photos: [DisputeEvidencePhoto]
        /// Picked and not included, because the tray was full or the file could
        /// not be read. Surfaced rather than dropped silently - on a dispute the
        /// missing photo may be the one that wins it.
        let skipped: Int
    }

    /// Downscale, then encode. The order matters: base64 inflates by a third and
    /// eight full-resolution photos in one JSON body is a request that times out
    /// on the shop-floor signal where a dispute actually gets filed.
    static func photos(from results: [PHPickerResult], room: Int) async -> Result {
        guard room > 0 else { return Result(photos: [], skipped: results.count) }
        var out: [DisputeEvidencePhoto] = []
        var skipped = 0
        for result in results {
            if out.count >= room {
                skipped += 1
                continue
            }
            guard let image = await result.loadImage(),
                  let output = await PhotoCompressor.compressOffMain(image)
            else {
                skipped += 1
                continue
            }
            out.append(
                DisputeEvidencePhoto(
                    dataURL: ImageDataURL.jpeg(output.imageData),
                    thumbnail: output.thumbnail
                )
            )
        }
        return Result(photos: out, skipped: skipped)
    }
}

/// A picked evidence photo, held until the filing is sent.
struct DisputeEvidencePhoto: Identifiable, Equatable {
    let id = UUID()
    let dataURL: String
    let thumbnail: UIImage

    static func == (lhs: DisputeEvidencePhoto, rhs: DisputeEvidencePhoto) -> Bool {
        lhs.id == rhs.id
    }
}
