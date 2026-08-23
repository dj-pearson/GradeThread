import Foundation
import UIKit

/// US-2016 — the transport for a consumer photo grade.
///
/// Deliberately the same shape as ``VideoGradeUploadService``: same endpoint,
/// same auth, same body-to-a-file discipline, same response decode. What
/// differs is the parts — `images` + `image_types` instead of a clip — and the
/// fact that a photo submission has no progress worth showing beyond the upload
/// itself.
///
/// THE BODY GOES TO A FILE, not to `Data`, for the reason the video path
/// records: fourteen photos plus their multipart copy is twice the resident
/// memory on a phone that has just been running the camera. Photos are smaller
/// than a clip, so this matters less — but the failure it prevents is a jetsam
/// kill mid-upload, which is silent and looks like a network fault.
enum PhotoGradeUploadService {
    enum UploadError: LocalizedError, Equatable {
        case notSignedIn

        var errorDescription: String? {
            switch self {
            case .notSignedIn:
                return "Sign in to send this for grading."
            }
        }
    }

    /// Bounded session, matching the rest of the app (US-992/US-1407). A stalled
    /// upload fails as a transient network error rather than hanging behind a
    /// spinner for a minute.
    private static var session: URLSession { EdgeNetwork.shared }

    static func submit(
        images: [PhotoGradeImage],
        request: PhotoGradeRequest,
        onProgress: @MainActor @escaping (Double) -> Void
    ) async throws -> PhotoGradeOutcome {
        // Refuse before spending the upload. Each of these is something the
        // route answers with a 400 or an abstain AFTER the body has gone up.
        if let rejection = PhotoGradeFields.validate(images) { throw rejection }

        guard let token = await SupabaseShared.currentAccessToken() else {
            throw UploadError.notSignedIn
        }
        let boundary = "Boundary-\(UUID().uuidString)"
        let bodyURL = try writeBody(images: images, request: request, boundary: boundary)
        defer { try? FileManager.default.removeItem(at: bodyURL) }

        var urlRequest = URLRequest(
            url: AppConfig.edgeAPIURL.appendingPathComponent("api/grade/submit"))
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        urlRequest.setValue(
            "multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        let delegate = PhotoUploadProgressDelegate(onProgress: onProgress)
        let (data, response) = try await session.upload(
            for: urlRequest, fromFile: bodyURL, delegate: delegate)

        let status = (response as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(status) else {
            throw EdgeAPIError.from(statusCode: status, body: data)
        }
        return try outcome(from: data)
    }

    /// Reads the submit reply.
    ///
    /// ⚠ NO ABSTAIN HERE, and my first draft got this wrong by copying the video
    /// path. The VIDEO route can abstain at submit time, because it decides
    /// there and then whether the clip showed every required view. The PHOTO
    /// path cannot: the image-quality gate runs inside the grading pipeline, so
    /// submit returns a created submission and `needs_photos` arrives later on
    /// `GET /status/:id` with `quality_feedback`. Detecting an abstain from this
    /// reply would be reading a field the route never sends on this path.
    static func outcome(from data: Data) throws -> PhotoGradeOutcome {
        let decoded: PhotoSubmitResponse
        do {
            decoded = try JSONDecoder().decode(PhotoSubmitResponse.self, from: data)
        } catch {
            throw EdgeAPIError.decoding(error.localizedDescription)
        }
        guard let id = decoded.id, !id.isEmpty else {
            // An empty id flowing forward is worse than a decode error: it
            // produces a "graded" result pointing at nothing.
            throw EdgeAPIError.decoding("The grade response carried no submission id.")
        }
        return .submitted(submissionId: id, paid: decoded.payment?.paid ?? false)
    }

    // MARK: - Multipart body

    private static func writeBody(
        images: [PhotoGradeImage],
        request: PhotoGradeRequest,
        boundary: String
    ) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("photograde-\(UUID().uuidString.lowercased()).body")
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }

        func write(_ string: String) throws {
            try handle.write(contentsOf: Data(string.utf8))
        }

        // The live-capture opt-in rides with the plain fields: it is one
        // value for the whole submission, unlike the per-image sources below.
        for (name, value) in PhotoGradeFields.fields(for: request)
            + PhotoGradeFields.liveCaptureFields(for: images) {
            try write(
                "--\(boundary)\r\n"
                    + "Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n"
                    + "\(value)\r\n")
        }

        // The THREE arrays are POSITIONAL: the route zips images[i] with
        // image_types[i] and capture_sources[i]. Writing them in one loop is
        // what keeps them aligned - two separate loops is how a reorder
        // silently mislabels every photo, and a back shot graded as a tag is a
        // wrong grade rather than an error. US-2802 added the third and it
        // belongs in the same loop for the same reason: a source attached to
        // the wrong photo is a provenance claim about an image nobody made it
        // about.
        for (index, image) in images.enumerated() {
            try write(
                "--\(boundary)\r\n"
                    + "Content-Disposition: form-data; name=\"images\";"
                    + " filename=\"\(image.gradingType)-\(index).jpg\"\r\n"
                    + "Content-Type: image/jpeg\r\n\r\n")
            try handle.write(contentsOf: image.jpeg)
            try write("\r\n")
            try write(
                "--\(boundary)\r\n"
                    + "Content-Disposition: form-data; name=\"image_types\"\r\n\r\n"
                    + "\(image.gradingType)\r\n")
            try write(
                "--\(boundary)\r\n"
                    + "Content-Disposition: form-data;"
                    + " name=\"\(PhotoGradeContract.captureSourcesField)\"\r\n\r\n"
                    + "\(image.captureSource)\r\n")
        }

        try write("--\(boundary)--\r\n")
        return url
    }
}

/// The submit reply.
struct PhotoSubmitResponse: Decodable {
    let submissionId: String?
    let submission_id: String?
    let status: String?
    let payment: Payment?

    struct Payment: Decodable {
        let paid: Bool?
        let charged: Bool?
    }

    /// The route sends `submissionId` on every path; the snake_case key is a
    /// DEFENSIVE fallback rather than an observed variance - labelled as such
    /// because a tolerance that reads like an observation invites the next
    /// person to believe the route is inconsistent when it is not.
    var id: String? { submissionId ?? submission_id }
}

/// Reports upload progress. The task-level number covers the whole body, which
/// here is the photos plus a few hundred bytes of field parts, so it is the
/// user's number without adjustment.
private final class PhotoUploadProgressDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let onProgress: @MainActor (Double) -> Void

    init(onProgress: @escaping @MainActor (Double) -> Void) {
        self.onProgress = onProgress
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64,
        totalBytesExpectedToSend: Int64
    ) {
        guard totalBytesExpectedToSend > 0 else { return }
        let fraction = Double(totalBytesSent) / Double(totalBytesExpectedToSend)
        Task { @MainActor [onProgress] in onProgress(min(1, fraction)) }
    }
}
