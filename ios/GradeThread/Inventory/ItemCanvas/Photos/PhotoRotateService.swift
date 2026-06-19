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
    private static let bucket = "item-photos"

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
        guard let sourceURL = URL(string: photo.photoURL) else { throw RotateError.downloadFailed }

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

        try await upload(output.imageData, to: storagePath)

        // Cache-bust so clients and eBay's fetch see the new bytes despite the
        // unchanged path. Point the thumbnail at the same fresh URL so it isn't
        // left showing the pre-rotation crop.
        let busted = "\(Self.publicURL(for: storagePath))?v=\(Int(Date.now.timeIntervalSince1970 * 1000))"
        let encoded = UIImage(data: output.imageData)
        let newWidth = encoded.map { Int($0.size.width * $0.scale) }
        let newHeight = encoded.map { Int($0.size.height * $0.scale) }

        try await supabase
            .from("item_photos")
            .update(PhotoURLUpdate(
                photo_url: busted,
                thumbnail_url: photo.thumbnailURL == nil ? nil : busted,
                width: newWidth,
                height: newHeight
            ))
            .eq("id", value: photo.id)
            .execute()

        photo.photoURL = busted
        if photo.thumbnailURL != nil { photo.thumbnailURL = busted }
        photo.width = newWidth
        photo.height = newHeight
        try? context.save()
    }

    // MARK: - Helpers

    private func upload(_ data: Data, to path: String) async throws {
        guard let accessToken = await SupabaseShared.currentAccessToken() else {
            throw RotateError.uploadFailed(401)
        }
        guard let url = StorageURL.object(base: AppConfig.supabaseURL, bucket: Self.bucket, path: path) else {
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
        StorageURL.publicObject(base: AppConfig.supabaseURL, bucket: Self.bucket, path: path)?
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
