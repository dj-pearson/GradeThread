import Foundation
import Supabase
import SwiftData
import UIKit

/// Rotates an item photo 90° and re-uploads it in place (same storage path) so
/// the stored pixels are upright. We bake rotation into the pixels rather than
/// relying on EXIF because eBay ignores orientation tags — and editing a photo
/// on eBay's own site triggers "A mixture of Self Hosted and EPS pictures are
/// not allowed". Rotating here keeps every image self-hosted; a follow-up
/// "Sync photo order to eBay" pushes the new bytes to the live listing.
@MainActor
struct PhotoRotateService {
    private let supabase: SupabaseClient
    private let session: URLSession

    init(
        supabase: SupabaseClient = SupabaseShared.client,
        // US-992: bounded-timeout session so the download/upload round-trip
        // fails fast on a stalled connection instead of hanging ~60s.
        session: URLSession = EdgeNetwork.shared
    ) {
        self.supabase = supabase
        self.session = session
    }

    enum RotateError: LocalizedError {
        case noStoragePath
        case downloadFailed
        case encodeFailed
        case uploadFailed(Int)
        case invalidStorageURL

        var errorDescription: String? {
            switch self {
            case .noStoragePath: return "This photo has no storage path, so it can't be rotated."
            case .downloadFailed: return "Couldn't load the photo to rotate."
            case .encodeFailed: return "Couldn't save the rotated photo."
            case .uploadFailed(let code): return "Upload failed (HTTP \(code))."
            case .invalidStorageURL: return "Storage isn't configured correctly."
            }
        }
    }

    private struct PhotoURLUpdate: Encodable {
        let photo_url: String
        let thumbnail_url: String?
        let width: Int?
        let height: Int?
    }

    /// Rotates `photo` 90° (clockwise by default), writes the new bytes back to
    /// the same storage path + item_photos row, and mirrors the change locally
    /// so the UI refreshes immediately. Throws on any failure (local row left
    /// untouched so the next sync re-reconciles).
    func rotate(
        _ photo: LocalItemPhoto,
        clockwise: Bool = true,
        context: ModelContext
    ) async throws {
        guard let storagePath = photo.storagePath else { throw RotateError.noStoragePath }

        // US-979: sensitive photos live in the PRIVATE bucket and have no public
        // URL — resolve a short-TTL signed URL to read the current bytes.
        let bucket = PhotoStorageBucket.bucket(forServerType: photo.photoType)
        let sourceURL: URL?
        if bucket == PhotoStorageBucket.publicBucket {
            sourceURL = URL(string: photo.photoURL)
        } else {
            sourceURL = await PhotoSignedURLProvider.shared.signedURL(bucket: bucket, path: storagePath)
        }
        guard let sourceURL else { throw RotateError.downloadFailed }

        let (data, response) = try await session.data(from: sourceURL)
        guard
            let http = response as? HTTPURLResponse,
            (200..<300).contains(http.statusCode),
            let image = UIImage(data: data)
        else {
            throw RotateError.downloadFailed
        }

        // Rotate, then run through the shared compressor (resize + JPEG encode +
        // EXIF strip; the rotated image is already `.up`).
        let rotated = Self.rotated(image, clockwise: clockwise)
        guard let output = await PhotoCompressor.compressOffMain(rotated) else {
            throw RotateError.encodeFailed
        }

        try await upload(output.imageData, to: storagePath, bucket: bucket)

        let encoded = UIImage(data: output.imageData)
        let newWidth = encoded.map { Int($0.size.width * $0.scale) }
        let newHeight = encoded.map { Int($0.size.height * $0.scale) }

        // Public photos: cache-bust the public URL so clients and eBay's fetch
        // see the new bytes despite the unchanged path. Sensitive photos have no
        // public URL — keep `photo_url` empty so display re-signs from the path.
        let newPhotoURL: String
        let newThumbnailURL: String?
        if bucket == PhotoStorageBucket.publicBucket {
            let busted = "\(Self.publicURL(for: storagePath))?v=\(Int(Date.now.timeIntervalSince1970 * 1000))"
            newPhotoURL = busted
            newThumbnailURL = photo.thumbnailURL == nil ? nil : busted
        } else {
            newPhotoURL = ""
            newThumbnailURL = nil
        }

        try await supabase
            .from("item_photos")
            .update(PhotoURLUpdate(
                photo_url: newPhotoURL,
                thumbnail_url: newThumbnailURL,
                width: newWidth,
                height: newHeight
            ))
            .eq("id", value: photo.id)
            .execute()

        photo.photoURL = newPhotoURL
        photo.thumbnailURL = newThumbnailURL
        photo.width = newWidth
        photo.height = newHeight
        try? context.save()
    }

    // MARK: - Helpers

    private func upload(_ data: Data, to path: String, bucket: String) async throws {
        guard let accessToken = await SupabaseShared.currentAccessToken() else {
            throw RotateError.uploadFailed(401)
        }
        guard let url = StorageURL.object(base: AppConfig.supabaseURL, bucket: bucket, path: path) else {
            throw RotateError.invalidStorageURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        // x-upsert matches the upload path — overwrite the bytes at this path.
        request.setValue("true", forHTTPHeaderField: "x-upsert")
        request.httpBody = data

        let (_, response) = try await session.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(code) else { throw RotateError.uploadFailed(code) }
    }

    private static func publicURL(for path: String) -> String {
        StorageURL.publicObject(base: AppConfig.supabaseURL, bucket: PhotoStorageBucket.publicBucket, path: path)?
            .absoluteString ?? ""
    }

    /// 90° rotation that bakes the result upright (`.up`).
    static func rotated(_ image: UIImage, clockwise: Bool) -> UIImage {
        let radians = clockwise ? CGFloat.pi / 2 : -CGFloat.pi / 2
        let swapped = CGSize(width: image.size.height, height: image.size.width)
        let format = UIGraphicsImageRendererFormat()
        format.scale = image.scale
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: swapped, format: format)
        return renderer.image { ctx in
            let cg = ctx.cgContext
            cg.translateBy(x: swapped.width / 2, y: swapped.height / 2)
            cg.rotate(by: radians)
            image.draw(in: CGRect(
                x: -image.size.width / 2,
                y: -image.size.height / 2,
                width: image.size.width,
                height: image.size.height
            ))
        }
    }
}
