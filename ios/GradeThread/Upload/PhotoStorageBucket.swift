import Foundation

/// Single source of truth for WHICH Supabase Storage bucket a photo belongs in,
/// and the sensitivity policy behind it (US-979).
///
/// `item-photos` is the only PUBLIC bucket — seller listing imagery the
/// marketplace fetches by a permanent, guessable public URL. Sensitive
/// close-ups (care/size labels, second tags, grading certificates) can expose
/// PII or grading-label content, so per the storage hardening rules in
/// CLAUDE.md they must live in the PRIVATE `submission-images` bucket and be
/// read ONLY through short-TTL signed URLs (see ``PhotoSignedURLProvider``). A
/// permanent `/object/public/` URL for those would leak PII to anyone who can
/// enumerate the path.
enum PhotoStorageBucket {
    /// Public listing-imagery bucket (front/back/detail/flatlay/…).
    static let publicBucket = "item-photos"

    /// Private bucket for PII / grading-label close-ups. Read via signed URLs.
    static let privateBucket = "submission-images"

    /// Server `item_photos.photo_type` strings whose imagery is sensitive and
    /// must NEVER be publicly addressable. Mirror of ``PhotoSlotType/isSensitive``;
    /// kept as raw server strings because the persisted-photo display + edge
    /// paths only carry the string, not the capture-time slot.
    static let sensitiveServerTypes: Set<String> = [
        "tag",          // care + size label — can carry handwritten names / PII
        "tag_2",        // second tag — brand stamp, size dot, care label
        "certificate",  // grading label / certificate of authenticity
    ]

    /// Whether a persisted photo's server `photo_type` is sensitive.
    static func isSensitive(serverType: String) -> Bool {
        sensitiveServerTypes.contains(serverType)
    }

    /// The bucket a persisted photo lives in, derived from its server
    /// `photo_type`. Sensitive → private; everything else → public.
    static func bucket(forServerType serverType: String) -> String {
        isSensitive(serverType: serverType) ? privateBucket : publicBucket
    }

    /// The bucket to READ a persisted photo from — trusting where the bytes
    /// ACTUALLY are, not the type. A populated public `photoURL` means the
    /// object lives in the PUBLIC bucket even for a nominally-sensitive type:
    /// legacy uploads (pre-US-979, when every slot went to `item-photos`) and
    /// slots reclassified to tag/tag_2/certificate AFTER capture leave a
    /// sensitive-typed row pointing at a public object. Routing those through
    /// the private signed-URL path mints a token for an object that isn't in the
    /// private bucket, so the photo silently fails to load (and rotate fails).
    /// An EMPTY `photoURL` is the private-upload shape, so it routes private.
    ///
    /// US-2407: the server type is no longer consulted for the empty case
    /// either — it used to be, and that made the answer flip when the seller
    /// changed the type dropdown: retagging a phone-captured Garment Tag to
    /// "Front" sent every reader to the public bucket for bytes that had not
    /// moved, and the photo blanked out. Where an object lives cannot depend on
    /// what it is called, so the type is gone from the signature rather than
    /// left in it to be re-used by mistake. (`bucket(forServerType:)` remains
    /// the WRITE-time router, keyed on the slot's sensitivity — that one runs
    /// before any bytes exist.)
    static func readBucket(photoURL: String) -> String {
        photoURL.isEmpty ? privateBucket : publicBucket
    }

    /// Maximum signed-URL lifetime, in seconds. Per CLAUDE.md the private
    /// bucket is read only via signed URLs with TTL ≤ 900s (15 minutes); we
    /// default to 10 minutes — long enough for the edge (Claude Vision) to
    /// fetch during AI extract, short enough that a leaked URL self-expires.
    static let signedURLTTLSeconds = 600

    /// Hard upper bound enforced on any requested TTL (15 minutes).
    static let signedURLMaxTTLSeconds = 900
}

public extension PhotoSlotType {
    /// True when this slot's imagery can expose PII (names/addresses on care
    /// labels) or grading-label content. Sensitive slots route to the PRIVATE
    /// `submission-images` bucket, never the public `item-photos` bucket.
    var isSensitive: Bool {
        PhotoStorageBucket.isSensitive(serverType: serverPhotoType)
    }

    /// The Storage bucket this slot's captured photo must be uploaded to.
    var storageBucket: String {
        PhotoStorageBucket.bucket(forServerType: serverPhotoType)
    }
}
