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
        // URL — resolve a short-TTL signed URL to read the current bytes. Use the
        // READ-time bucket (populated public photoURL ⇒ public bucket) so a
        // sensitive-typed-but-public legacy/reclassified row is downloaded AND
        // re-uploaded to the bucket its bytes actually occupy, instead of signing
        // / writing the private bucket where the object isn't (the HTTP 400).
        let bucket = PhotoStorageBucket.readBucket(photoURL: photo.photoURL)
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

        // US-2889: the dimensions the stored calibration is written in, taken
        // from the image we just decoded rather than from photo.width/height.
        // Those columns were not written at all before US-2888, so a row from
        // before then carries nil, and a row written by another client can be
        // stale. The decoded bytes cannot be.
        let sourceWidth = Double(image.size.width * image.scale)
        let sourceHeight = Double(image.size.height * image.scale)

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

        // US-2889: the calibration describes the OLD pixels until this runs.
        //
        // The homography would go on measuring along the old axis, and every
        // stored endpoint would keep its old coordinate - so a portrait-to-
        // landscape turn puts endpoints outside the frame, where the editor
        // draws them off screen and neither a drag nor a nudge can reach them,
        // because both need the endpoint visible. This is the iOS half of what
        // US-2888 fixed on the web.
        //
        // Deliberately AFTER the row update and deliberately non-fatal. The
        // bytes are already rotated at this point; failing the whole rotate
        // because the calibration could not be rewritten would leave the seller
        // with an unrotated-looking failure and rotated pixels. A warning in
        // the breadcrumb trail and a calibration the editor will re-detect is
        // the better of the two bad outcomes.
        await carryCalibration(
            photoId: photo.id,
            clockwise: clockwise,
            sourceWidth: sourceWidth,
            sourceHeight: sourceHeight,
            outputWidth: newWidth.map(Double.init),
            outputHeight: newHeight.map(Double.init)
        )

        photo.photoURL = newPhotoURL
        photo.thumbnailURL = newThumbnailURL
        photo.width = newWidth
        photo.height = newHeight
        // Bump the local cache-buster so the display refetches the rotated bytes.
        // Public photos already bust via the new `?v=` in `newPhotoURL`, but a
        // private photo (tag/tag_2/certificate) keeps an empty `photoURL` and is
        // re-signed from the unchanged path — so without this every thumbnail
        // cache key stays identical and the rotation silently no-ops on screen.
        photo.localCacheToken &+= 1
        // Mark the parent item changed — mirrors PhotoEditService.applyLocalOrder
        // (reorder/delete). Without this a rotate-only edit never bumps the item's
        // updatedAt, so the sync engine + any "needs sync" affordance treat the
        // item as unchanged and the rotation doesn't drive a Save & Sync.
        photo.item?.updatedAt = .now
        context.saveOrLog("rotate")
    }

    // MARK: - Helpers

    /// Move the photo's stored calibration onto the rotated pixels (US-2889).
    ///
    /// A quarter turn is rigid, so nothing is re-detected: the homography is
    /// post-multiplied by the inverse quarter affine and every endpoint goes
    /// through the same map the pixels took. The inches are unchanged, which is
    /// the whole reason this is a carry rather than a re-calibration.
    ///
    /// Silent when the photo has no calibration, which is almost every photo.
    private func carryCalibration(
        photoId: String,
        clockwise: Bool,
        sourceWidth: Double,
        sourceHeight: Double,
        outputWidth: Double?,
        outputHeight: Double?
    ) async {
        // Clockwise is one quarter; counter-clockwise is three. Expressing the
        // anti-clockwise case as 3 rather than -1 keeps every turn in this file
        // in the same 0..<4 space the fixture and the web use.
        let turns: MeasureQuarterTurn.Quarter = clockwise ? .one : .three
        let service = MeasureService()
        do {
            guard let current = try await service.loadCalibration(photoId: photoId) else { return }
            let turned = MeasureService.rotated(
                current, turns: turns, w: sourceWidth, h: sourceHeight
            )

            // The compressor resizes, so the bytes on the server are not the
            // bytes that were turned. Take the scale from what was ACTUALLY
            // encoded rather than from the compressor's budget: the budget is a
            // ceiling and a photo already under it comes back untouched.
            let turnedSize = MeasureQuarterTurn.rotatedDims(
                w: sourceWidth, h: sourceHeight, turns: turns
            )
            let moved: MeasureService.Calibration
            if let outputWidth, let outputHeight,
               outputWidth > 0, outputHeight > 0,
               Double(turnedSize.width) > 0, Double(turnedSize.height) > 0,
               // The scale must be UNIFORM, and this is what checks it rather
               // than assuming it. resize(_:maxLongEdge:) preserves aspect, but
               // it floors both sides independently, so a very tall photo can
               // land a fraction of a percent off square. A tolerance of 1% is
               // far wider than that rounding and far tighter than any real
               // reframe, so a genuine non-uniform resize falls to the else
               // branch instead of skewing every measurement.
               abs((outputWidth / Double(turnedSize.width))
                   - (outputHeight / Double(turnedSize.height))) < 0.01 {
                moved = MeasureService.scaled(
                    turned, by: outputWidth / Double(turnedSize.width)
                )
            } else {
                // No decodable output size means no trustworthy scale. Write the
                // turn alone rather than guess a factor: a wrong scale is a
                // measurement that is quietly short, which is worse than a
                // measurement that is visibly in the wrong place.
                moved = turned
            }
            try await service.writeCalibration(photoId: photoId, calibration: moved)
        } catch {
            Telemetry.breadcrumb(
                "photo rotate: calibration carry failed for \(photoId): \(error.localizedDescription)",
                category: "photos"
            )
        }
    }

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

        let (body, response) = try await session.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(code) else {
            // Surface the storage error body (previously discarded). A bare
            // "Upload failed (HTTP 400)" is undiagnosable — Supabase Storage
            // returns the real reason in the body (e.g. "mime type ... is not
            // supported", "Invalid key", an RLS message), and tag/cert photos
            // hit the stricter PRIVATE bucket where these surface first.
            let detail = String(data: body, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            Telemetry.breadcrumb(
                "photo rotate upload failed: HTTP \(code) bucket=\(bucket) body=\(detail.prefix(300))",
                category: "photos"
            )
            throw RotateError.uploadFailed(code)
        }
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
