import Foundation

/// The fields of a PERSISTED `item_photos` row that decide what URL the AI can
/// read it by. A plain value type (not the SwiftData `LocalItemPhoto`) so the
/// resolution rules below are unit-testable without a model container.
struct PersistedPhotoRef: Equatable {
    /// Server `item_photos.photo_type` — front / back / tag / detail / …
    let photoType: String
    let storagePath: String?
    /// Empty for a PRIVATE-bucket photo (US-979); a permanent public URL
    /// otherwise. This is the same signal the edge's `readBucketForItemPhoto`
    /// keys on, and `PhotoStorageBucket.readBucket` already encodes the rule.
    let photoURL: String
}

/// Builds the `photos` array for a RE-RUN of the AI extract on an item that
/// already exists (US-2266).
///
/// The post-capture path in ``AIExtractionManager`` works from in-memory
/// captures and their upload tasks. A re-run has neither: the photos are long
/// since uploaded, so the URLs have to come off the persisted rows. The two
/// rules that matter, and that the capture path also applies:
///
///   * A sensitive close-up (tag / tag_2 / certificate) lives in the PRIVATE
///     bucket and has NO public URL, so it needs a short-TTL signed one. This is
///     the single most informative photo for brand/size/material, so dropping it
///     silently is the difference between a good fill and a thin one.
///   * `internal` (the seller's price tag / receipt) and `measurement` (the
///     MeasureCard frame) are never fed to an AI pass — US-1549 / US-1571. The
///     edge filters them too; filtering here also stops them consuming slots in
///     the server's 8-photo cap.
enum AIRerunPhotos {
    /// Mints a signed URL for a private-bucket object. Injected so tests don't
    /// need the network.
    typealias Signer = (_ bucket: String, _ path: String) async -> URL?

    static let defaultSigner: Signer = { bucket, path in
        await PhotoSignedURLProvider.shared.signedURL(bucket: bucket, path: path)
    }

    /// Resolves each row to a typed ``ExtractPhoto``, preserving input order
    /// (the caller passes them in `sortOrder`, and the server's photo cap keeps
    /// the first N — so front/back/tag must stay at the front). Rows that can't
    /// be resolved are dropped rather than sent as a URL that 404s.
    static func build(
        from refs: [PersistedPhotoRef],
        signer: Signer = defaultSigner
    ) async -> [ExtractPhoto] {
        var out: [ExtractPhoto] = []
        for ref in refs {
            // FlipdeskPhotoType, not PhotoSlotType: these are PERSISTED rows, so
            // they carry the server `photo_type` string rather than a capture-time
            // slot (see the comment on FlipdeskPhotoType).
            guard !FlipdeskPhotoType.isNonListable(ref.photoType) else { continue }
            let path = ref.storagePath?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let stored = ref.photoURL.trimmingCharacters(in: .whitespacesAndNewlines)

            // Trust where the bytes ACTUALLY are: a populated photoURL means the
            // object is in the public bucket even for a nominally-sensitive type
            // (web uploads every type there, and so did pre-US-979 iOS builds).
            let bucket = PhotoStorageBucket.readBucket(
                forServerType: ref.photoType,
                photoURL: stored
            )
            if bucket == PhotoStorageBucket.publicBucket {
                if !stored.isEmpty {
                    out.append(ExtractPhoto(url: stored, type: ref.photoType))
                }
                // No stored URL and no way to derive one safely → skip. (A public
                // photo always carries its photoURL; a row without one is either
                // mid-upload or malformed.)
                continue
            }

            guard !path.isEmpty,
                  let signed = await signer(bucket, path)
            else { continue }
            out.append(ExtractPhoto(url: signed.absoluteString, type: ref.photoType))
        }
        return out
    }
}
