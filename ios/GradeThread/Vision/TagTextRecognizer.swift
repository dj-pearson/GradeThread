import CoreGraphics
import Foundation
import UIKit
import Vision

/// On-device OCR for size-tag photos. Wraps `VNRecognizeTextRequest` at
/// the `.accurate` level — slower than `.fast` but markedly better at
/// reading the small, often-rotated text printed on care tags.
///
/// Runs entirely on-device: no network, no Claude usage, works offline.
/// Used as a fallback in ``AIExtractView`` when Claude's extract result
/// is missing brand or size (per US-177 AC).
struct RecognizedLine: Equatable {
    let text: String
    let confidence: Float
    /// Normalized bounding box (0…1 in Vision's coordinate system).
    let boundingBox: CGRect
}

actor TagTextRecognizer {

    enum RecognizerError: LocalizedError {
        case noCGImage
        case visionFailure(String)

        var errorDescription: String? {
            switch self {
            case .noCGImage:
                return "Couldn't read pixels from the tag photo."
            case .visionFailure(let detail):
                return "Vision OCR failed: \(detail)"
            }
        }
    }

    func recognize(_ image: UIImage) async throws -> [RecognizedLine] {
        guard let cgImage = image.cgImage else { throw RecognizerError.noCGImage }

        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<[RecognizedLine], Error>) in
            // US-1648: one-shot resume guard. VNRecognizeTextRequest's completion
            // runs synchronously INSIDE handler.perform(); a Vision failure that
            // both invokes the completion (resume) AND makes perform throw (the
            // catch resumes again) would resume the SAME continuation twice —
            // "SWIFT TASK CONTINUATION MISUSE" → process abort. Resume at most once.
            var didResume = false
            func resumeReturning(_ v: [RecognizedLine]) {
                guard !didResume else { return }
                didResume = true
                cont.resume(returning: v)
            }
            func resumeThrowing(_ e: Error) {
                guard !didResume else { return }
                didResume = true
                cont.resume(throwing: e)
            }
            let request = VNRecognizeTextRequest { (request, error) in
                if let error {
                    resumeThrowing(RecognizerError.visionFailure(error.localizedDescription))
                    return
                }
                let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
                let lines: [RecognizedLine] = observations.compactMap { obs in
                    guard let candidate = obs.topCandidates(1).first else { return nil }
                    let trimmed = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !trimmed.isEmpty else { return nil }
                    return RecognizedLine(
                        text: trimmed,
                        confidence: candidate.confidence,
                        boundingBox: obs.boundingBox
                    )
                }
                resumeReturning(lines)
            }
            request.recognitionLevel = .accurate
            // Tags are usually English-printed, but allow multi-language
            // recognition so we don't lose imported brands (Levi's,
            // Uniqlo, etc.) when the tag mixes scripts.
            // US-1178: actually pass a multi-language list (was locked to en-US,
            // which contradicted the comment). Vision uses whatever models are
            // available; en stays first so it's preferred.
            request.usesLanguageCorrection = true
            request.recognitionLanguages = ["en-US", "fr-FR", "es-ES", "de-DE", "it-IT", "pt-BR", "ja-JP"]
            // Don't restrict character set — tag content includes punctuation
            // ('Size 12 / W30 L32', care symbols).

            let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
            do {
                try handler.perform([request])
            } catch {
                resumeThrowing(RecognizerError.visionFailure(error.localizedDescription))
            }
        }
    }
}
