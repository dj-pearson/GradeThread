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

    /// Re-resolve when the underlying photo identity / source changes.
    private var resolveKey: String {
        "\(photo.photoType)|\(photo.storagePath ?? "")|\(photo.thumbnailURL ?? photo.photoURL)"
    }

    private func resolve() async {
        // Read from where the bytes ACTUALLY are: a populated public photoURL
        // means the object is in the public bucket even for a sensitive type
        // (legacy / reclassified rows), so we don't mint a doomed private signed
        // URL for an object that isn't there — the cause of tag/tag_2 photos
        // showing blank until they're reclassified to a non-sensitive type.
        let bucket = PhotoStorageBucket.readBucket(forServerType: photo.photoType, photoURL: photo.photoURL)
        if bucket == PhotoStorageBucket.publicBucket {
            resolvedURL = URL(string: photo.thumbnailURL ?? photo.photoURL)
            return
        }
        resolvedURL = await PhotoSignedURLProvider.shared.displayURL(
            bucket: bucket,
            storagePath: photo.storagePath,
            publicURL: photo.thumbnailURL ?? photo.photoURL
        )
    }
}
