import Foundation
import Observation

// US-2504 AC3/AC4: posting a walk-around clip and showing honest progress.
//
// The clip goes to /api/grade/submit as multipart, with the four field names
// VideoGradingContract mirrors. The response is either a normal grade or the
// ABSTAIN case — no usable required view came out of the clip — which lands the
// submission retakeable and UNCHARGED. That refund is the server's
// (failVideoGrading returns before payment precedence runs); this client only
// has to recognise it and say so.

/// Everything the submit needs besides the clip. Named rather than a dictionary
/// so a missing field is a compile error instead of a 400 after a 40 MB upload.
struct VideoGradeRequest: Equatable {
    var garmentType: String
    var garmentCategory: String
    var title: String
    var tier: String
    var brand: String?
    var description: String?
    /// Links the result back to a buyer's closet item. Clip path only — a photo
    /// grade already reaches the closet by certificate.
    var closetItemId: String?
}

/// What came back. The abstain case is a first-class outcome rather than an
/// error, because it is not a failure: the seller's clip was fine, it just did
/// not show a required view, and nothing was charged.
enum VideoGradeOutcome: Equatable {
    case graded(submissionId: String)
    case needsPhotos(submissionId: String, reason: String, requested: [String])
}

private struct VideoSubmitResponse: Decodable {
    let submissionId: String?
    let submission_id: String?
    let status: String?
    let photo_requests: [String]?
    let videoGrading: VideoGradingResult?
    let payment: Payment?

    struct VideoGradingResult: Decodable {
        let ok: Bool
        let reason: String?
    }

    struct Payment: Decodable {
        let paid: Bool?
        let charged: Bool?
    }

    /// The route sends `submissionId` on every path I read (grade.ts: the
    /// abstain reply, both paid replies and the free-tier reply). The
    /// snake_case key is a DEFENSIVE fallback, not an observed variance -
    /// worth having because it costs nothing, worth labelling because a
    /// tolerance that reads like an observation invites the next person to
    /// believe the route is inconsistent when it is not.
    ///
    /// nil when NEITHER is present, so the caller fails loudly. An empty
    /// string flowing forward as a submission id is worse than a decode
    /// error: it produces a "graded" result that points at nothing.
    var id: String? { submissionId ?? submission_id }
}

@MainActor
@Observable
final class VideoGradeUploader {

    enum Phase: Equatable {
        case idle
        /// Bytes are moving. `fraction` is 0...1 of the UPLOAD only.
        case uploading(fraction: Double)
        /// ⚠ THE STATE AC4 EXISTS FOR. The last byte has landed and the server
        /// is extracting frames and grading, sending nothing back. There is no
        /// number to show here and inventing one would be a lie, so this phase
        /// carries none and the UI must render it indeterminately.
        ///
        /// A client that finished at "100%" would tell the seller their grade is
        /// ready while the server has not started.
        case grading
        case finished(VideoGradeOutcome)
        case failed(String)
    }

    private(set) var phase: Phase = .idle

    /// The inner closure carries @escaping in the TYPE, matching the init
    /// parameter exactly. Written without it the two spellings are different
    /// types and the assignment does not compile - the error names the
    /// assignment rather than the missing keyword.
    private let upload: (URL, VideoGradeRequest, @escaping @MainActor (Double) -> Void) async throws -> VideoGradeOutcome

    init(
        upload: ((URL, VideoGradeRequest, @MainActor @escaping (Double) -> Void) async throws -> VideoGradeOutcome)? = nil
    ) {
        self.upload = upload ?? { url, request, onProgress in
            try await VideoGradeUploadService.submit(
                clipURL: url, request: request, onProgress: onProgress)
        }
    }

    func submit(clip: WalkAroundClip, request: VideoGradeRequest, photoPartCount: Int) async {
        // Refuse before spending the upload, in the server's own order — the
        // photo conflict first, because it is the only one the seller can fix
        // without re-recording.
        if let rejection = VideoGradingContract.rejection(
            bytes: clip.bytes,
            durationSeconds: clip.durationSeconds,
            format: clip.format,
            photoPartCount: photoPartCount
        ) {
            phase = .failed(rejection)
            return
        }
        phase = .uploading(fraction: 0)
        do {
            let outcome = try await upload(clip.url, request) { [weak self] fraction in
                guard let self else { return }
                // Never go backwards, and never past 1. A retried body segment can
                // report a lower cumulative count, and a bar that jumps back
                // reads as a failure.
                if case .uploading(let current) = self.phase {
                    self.phase = .uploading(fraction: max(current, min(1, fraction)))
                }
                if fraction >= 1, case .uploading = self.phase {
                    self.phase = .grading
                }
            }
            phase = .finished(outcome)
        } catch {
            phase = .failed(
                (error as? LocalizedError)?.errorDescription
                    ?? "We couldn't send that clip.")
        }
    }

    /// Back to idle so the seller can record again.
    ///
    /// Deliberately refuses while bytes are in flight: a "back" that abandoned
    /// an upload mid-request would leave the server holding a submission the
    /// client has forgotten about, and the seller with no way to reach it.
    func reset() {
        switch phase {
        case .uploading, .grading: return
        default: phase = .idle
        }
    }

    // MARK: - Copy

    /// What the seller reads under the bar. The grading phase says what is
    /// happening rather than holding at a number, because a bar parked at 100%
    /// with no words is indistinguishable from a hang — the same failure AC4
    /// names for the upload itself, one step later.
    static func statusText(for phase: Phase) -> String {
        switch phase {
        case .idle: return ""
        case .uploading(let fraction):
            return "Sending your clip - \(Int((fraction * 100).rounded()))%"
        case .grading:
            return "Sent. Reading the clip and grading - this takes a moment."
        case .finished(.graded): return "Graded."
        case .finished(.needsPhotos): return "We couldn't grade that clip."
        case .failed(let message): return message
        }
    }

    /// Whether the bar should be determinate. False during grading, where there
    /// is nothing to be determinate about.
    static func showsPercentage(for phase: Phase) -> Bool {
        if case .uploading = phase { return true }
        return false
    }
}

// MARK: - The service

enum VideoGradeUploadService {

    /// ⚠ THIS CANNOT USE EdgeNetwork.shared, and the reason is written in
    /// EdgeNetwork's own comments one level up.
    ///
    /// That session caps a resource at 60 seconds, which a 60 MB clip on
    /// cellular can exceed on the upload alone. Worse, once the last byte lands
    /// the connection sits legitimately IDLE while the server extracts frames
    /// and grades — exactly the shape EdgeNetwork.aiSession was created for
    /// after a 20-second idle timeout killed a 38-second AI extract that had
    /// already SUCCEEDED server-side, showing a failure for a result that was on
    /// its way.
    ///
    /// A video grade is that same trap with a large upload in front of it, so
    /// both ceilings are raised rather than one.
    static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 180
        config.timeoutIntervalForResource = 600
        return URLSession(configuration: config)
    }()

    enum UploadError: LocalizedError {
        case notSignedIn
        case bodyWriteFailed
        case server(status: Int, detail: String?)

        var errorDescription: String? {
            switch self {
            case .notSignedIn: return "Sign in again to grade a clip."
            case .bodyWriteFailed: return "We couldn't prepare that clip for upload."
            case .server(let status, let detail):
                return detail ?? "The grade didn't go through (HTTP \(status))."
            }
        }
    }

    static func submit(
        clipURL: URL,
        request: VideoGradeRequest,
        onProgress: @MainActor @escaping (Double) -> Void
    ) async throws -> VideoGradeOutcome {
        guard let token = await SupabaseShared.currentAccessToken() else {
            throw UploadError.notSignedIn
        }
        let boundary = "Boundary-\(UUID().uuidString)"
        // The body is written to a FILE, not held in Data. A 60 MB clip plus its
        // multipart copy is 120 MB resident on a phone that may be under memory
        // pressure from the camera that just produced it.
        let bodyURL = try writeBody(clipURL: clipURL, request: request, boundary: boundary)
        defer { try? FileManager.default.removeItem(at: bodyURL) }

        var urlRequest = URLRequest(
            url: AppConfig.edgeAPIURL.appendingPathComponent("api/grade/submit"))
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        urlRequest.setValue(
            "multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        let delegate = ProgressDelegate(onProgress: onProgress)
        let (data, response) = try await session.upload(
            for: urlRequest, fromFile: bodyURL, delegate: delegate)

        let status = (response as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(status) else {
            throw EdgeAPIError.from(statusCode: status, body: data)
        }
        return try outcome(from: data)
    }

    /// Reads the response into an outcome. The abstain case is recognised by the
    /// SERVER'S markers — status plus charged:false — rather than by the client
    /// deciding a clip was unusable.
    static func outcome(from data: Data) throws -> VideoGradeOutcome {
        let decoded: VideoSubmitResponse
        do {
            decoded = try JSONDecoder().decode(VideoSubmitResponse.self, from: data)
        } catch {
            throw EdgeAPIError.decoding(error.localizedDescription)
        }
        guard let id = decoded.id, !id.isEmpty else {
            throw EdgeAPIError.decoding("The grade response carried no submission id.")
        }
        if decoded.status == VideoGradingContract.abstainStatus,
           decoded.payment?.charged == false {
            return .needsPhotos(
                submissionId: id,
                reason: decoded.videoGrading?.reason ?? "The clip didn't show every required view.",
                requested: decoded.photo_requests ?? [])
        }
        return .graded(submissionId: id)
    }

    // MARK: - Multipart body

    private static func writeBody(
        clipURL: URL,
        request: VideoGradeRequest,
        boundary: String
    ) throws -> URL {
        let bodyURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("videograde-\(UUID().uuidString.lowercased()).body")
        FileManager.default.createFile(atPath: bodyURL.path, contents: nil)
        guard let handle = try? FileHandle(forWritingTo: bodyURL) else {
            throw UploadError.bodyWriteFailed
        }
        defer { try? handle.close() }

        func writeField(_ name: String, _ value: String) throws {
            let part = "--\(boundary)\r\n"
                + "Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n"
                + "\(value)\r\n"
            try handle.write(contentsOf: Data(part.utf8))
        }

        for (name, value) in fields(for: request) {
            try writeField(name, value)
        }

        let filename = "walkaround.\(clipURL.pathExtension.isEmpty ? "mov" : clipURL.pathExtension)"
        let header = "--\(boundary)\r\n"
            + "Content-Disposition: form-data; name=\"\(VideoGradingContract.videoField)\";"
            + " filename=\"\(filename)\"\r\n"
            + "Content-Type: video/quicktime\r\n\r\n"
        try handle.write(contentsOf: Data(header.utf8))

        guard let clip = try? FileHandle(forReadingFrom: clipURL) else {
            throw UploadError.bodyWriteFailed
        }
        defer { try? clip.close() }
        // Streamed in chunks so peak memory is the chunk, not the clip.
        while let chunk = try clip.read(upToCount: 1 << 20), !chunk.isEmpty {
            try handle.write(contentsOf: chunk)
        }

        try handle.write(contentsOf: Data("\r\n--\(boundary)--\r\n".utf8))
        return bodyURL
    }

    /// The non-file fields, in one place so a test can read them without a file.
    static func fields(for request: VideoGradeRequest) -> [(String, String)] {
        var out: [(String, String)] = [
            ("garment_type", request.garmentType),
            ("garment_category", request.garmentCategory),
            ("title", request.title),
            ("tier", request.tier),
            // Both opt-ins sent explicitly false. The server re-checks either
            // way, but omitting them leaves the request's meaning to a default
            // that could change on the server without this client knowing.
            ("verified_capture_opt_in", "false"),
            ("authenticity_addon", "false"),
            (VideoGradingContract.videoGradingField, VideoGradingContract.videoGradingOptIn),
            (VideoGradingContract.videoCaptureSourceField,
             VideoGradingContract.captureSourceInAppRecorder),
        ]
        if let brand = request.brand, !brand.isEmpty { out.append(("brand", brand)) }
        if let description = request.description, !description.isEmpty {
            out.append(("description", description))
        }
        if let closetItemId = request.closetItemId, !closetItemId.isEmpty {
            out.append(("closet_item_id", closetItemId))
        }
        // NO images / image_types parts, ever. The server refuses photos
        // alongside a clip, and the refusal arrives after the upload.
        return out
    }
}

/// Reports upload progress. `URLSession`'s task-level progress covers the whole
/// body, which for us is the clip plus a few hundred bytes of field parts, so it
/// is the seller's number without adjustment.
private final class ProgressDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
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
        Task { @MainActor [onProgress] in onProgress(fraction) }
    }
}
