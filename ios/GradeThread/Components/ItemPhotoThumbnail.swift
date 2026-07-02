import SwiftUI

/// Thumbnail for a persisted `item_photos` row that resolves the right URL for
/// the photo's bucket (US-979): public photos use their permanent URL; private
/// (sensitive PII / grading-label) photos resolve a short-TTL signed URL before
/// loading. Wraps ``CachedThumbnail`` so caching / downsampling / tap-to-retry
/// behave identically everywhere a stored photo is shown.
struct ItemPhotoThumbnail<Placeholder: View>: View {
    let photo: LocalItemPhoto
    var maxDimension: CGFloat
    var contentMode: ContentMode = .fill
    @ViewBuilder var placeholder: () -> Placeholder

    @State private var resolvedURL: URL?

    var body: some View {
        CachedThumbnail(
            url: resolvedURL,
            maxDimension: maxDimension,
            contentMode: contentMode,
            placeholder: placeholder
        )
        .task(id: resolveKey) { await resolve() }
    }

    /// Re-resolve when the underlying photo identity / source changes. Includes
    /// `localCacheToken` so an in-place rotate of a private-bucket photo (whose
    /// URL string never changes) still re-fires this `.task` and refetches.
    private var resolveKey: String {
        "\(photo.photoType)|\(photo.storagePath ?? "")|\(photo.thumbnailURL ?? photo.photoURL)|\(photo.localCacheToken)"
    }

    private func resolve() async {
        // Read from where the bytes ACTUALLY are: a populated public photoURL
        // means the object is in the public bucket even for a sensitive type
        // (legacy / reclassified rows), so we don't mint a doomed private signed
        // URL for an object that isn't there — the cause of tag/tag_2 photos
        // showing blank until they're reclassified to a non-sensitive type.
        let bucket = PhotoStorageBucket.readBucket(forServerType: photo.photoType, photoURL: photo.photoURL)
        if bucket == PhotoStorageBucket.publicBucket {
            // Public photos carry their own `?v=` cache-buster on the URL after a
            // rotate, so no extra busting is needed here.
            resolvedURL = URL(string: photo.thumbnailURL ?? photo.photoURL)
            return
        }
        let signed = await PhotoSignedURLProvider.shared.displayURL(
            bucket: bucket,
            storagePath: photo.storagePath,
            publicURL: photo.thumbnailURL ?? photo.photoURL
        )
        // A rotate rewrites the bytes at the same signed path, so the signed URL
        // (cached ~10 min, keyed on the path) is byte-identical and every client
        // thumbnail cache would serve the pre-rotation image — bust them with the
        // photo's local cache token (an ignored `_cb` query param).
        resolvedURL = PhotoSignedURLProvider.cacheBusted(signed, token: photo.localCacheToken)
    }
}
