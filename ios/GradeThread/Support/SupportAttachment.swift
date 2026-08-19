import Foundation
import UIKit

/// US-2561 — the support-attachment contract, in Swift.
///
/// Every value here is a MIRROR of `src/lib/support-attachment-contract.ts`,
/// which is itself a transcription of the running edge route rather than a
/// decision. The guard in `src/test/support-attachment-contract.test.ts` reads
/// these numbers back out of this file and compares them to the TypeScript, so
/// the two cannot drift.
///
/// WHY THE NUMBERS MATTER, one line each, because each has a different failure:
/// the limit is enforced SERVER-side with a 400, so a client that lets you pick
/// four makes you wait for an upload it then throws away; the TTL decides when a
/// perfectly good URL string stops working; and the downscale is the difference
/// between a support reply and a timeout on a phone signal.
enum SupportAttachmentContract {
    /// Images per message. Also `MAX_ATTACHMENTS_PER_MESSAGE` in the edge route
    /// and `MAX_ATTACHMENTS` in the web picker. This is the third copy, and the
    /// guard exists because three copies of a number is three chances to be
    /// wrong.
    static let maxAttachments = 3

    /// Signed-URL lifetime as the GET issues them. The bucket is PRIVATE
    /// (US-276) and a support screenshot can contain anything, so these are
    /// deliberately short.
    static let urlTTLSeconds: TimeInterval = 600

    /// Treat a URL that is about to expire as already gone. One unnecessary
    /// re-fetch beats an image that fails to load after a spinner.
    static let urlExpiryMarginSeconds: TimeInterval = 30

    /// On-device downscale before upload, matching the web picker's
    /// `compressImage` defaults.
    ///
    /// ⚠ The web caps WIDTH and ``PhotoCompressor`` caps the LONG EDGE. They
    /// agree on a landscape photo and differ on a portrait one, where capping
    /// the long edge is the more aggressive of the two - so the iOS body is
    /// never larger than the web's for the same picture, which is the direction
    /// that matters. Recorded rather than silently reconciled.
    static let maxLongEdge: CGFloat = 2400
    static let jpegQuality: CGFloat = 0.85

    /// Whether a signed URL is still worth putting in an image view.
    ///
    /// TWO ways to have a dead URL, and a client that only nil-checks misses the
    /// second: signing failed server-side (nil), or the string was fine when it
    /// arrived and has since rotted in place. The second is the common one - a
    /// user reads a thread, switches apps, comes back twenty minutes later.
    static func isURLUsable(_ url: String?, fetchedAt: Date, now: Date) -> Bool {
        guard let url, !url.isEmpty else { return false }
        let age = now.timeIntervalSince(fetchedAt)
        // A clock that went backwards is not evidence the URL is fresh.
        guard age >= 0 else { return false }
        return age < urlTTLSeconds - urlExpiryMarginSeconds
    }

    /// `data:image/jpeg;base64,...` - the exact shape the server's decoder
    /// accepts. It requires an `image/<something>` media type and an explicit
    /// `;base64`; a bare `data:;base64,` is rejected as "not an image", which
    /// reads like a corrupt file rather than a malformed header.
    static func jpegDataURL(_ data: Data) -> String {
        "data:image/jpeg;base64," + data.base64EncodedString()
    }
}

/// One attachment as `GET /api/support-tickets/:id` returns it. Decoded with
/// the EdgeAPI decoder's `.convertFromSnakeCase`, so `content_type` lands here
/// as `contentType`.
struct SupportAttachmentView: Decodable, Equatable, Sendable, Identifiable {
    let path: String
    let name: String
    let contentType: String
    let bytes: Int
    /// Null when signing failed server-side.
    let url: String?

    /// The storage path is unique per message and stable across a re-fetch;
    /// the signed URL is not, so keying on it would rebuild every image view
    /// on every poll.
    var id: String { path }
}

/// One attachment as the POST bodies carry it.
///
/// `data_url`, snake_case, spelled out in ``CodingKeys``. The edge reads
/// `item?.data_url`; a camelCase key decodes to null there and surfaces as
/// "One attachment was not an image", with no hint that the bytes were fine and
/// the KEY was wrong. The EdgeAPI encoder's `.convertToSnakeCase` would
/// probably produce the same string, and "probably" is not a thing to bet a
/// silent failure on.
struct SupportAttachmentUpload: Encodable, Equatable, Sendable {
    let dataURL: String
    let name: String

    enum CodingKeys: String, CodingKey {
        case dataURL = "data_url"
        case name
    }
}

/// A picked image, downscaled and ready to send, with a thumbnail for the tray.
struct SupportAttachmentDraft: Identifiable, Equatable {
    let id = UUID()
    let upload: SupportAttachmentUpload
    let thumbnail: UIImage

    static func == (lhs: SupportAttachmentDraft, rhs: SupportAttachmentDraft) -> Bool {
        lhs.id == rhs.id
    }
}
