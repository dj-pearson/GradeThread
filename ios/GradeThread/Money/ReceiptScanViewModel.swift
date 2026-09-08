import Foundation
import Observation
import UIKit

/// US-3014 — the state of one receipt scan, and nothing else.
///
/// THE MODEL PROPOSES; THE SELLER CONFIRMS. Nothing here writes an expense.
/// It hands back a prefill and a staging path, and the ordinary expense form —
/// the same form, with the same validation — is what the seller then saves.
/// A separate "confirm the scan" screen would be a second way to create an
/// expense, and the two would drift.
@MainActor
@Observable
final class ReceiptScanViewModel {

    enum Phase: Equatable {
        case idle
        /// Uploading and waiting on the model. Tens of seconds is normal.
        case scanning
        case done(ReceiptScanResult)
        case failed(String)
    }

    private(set) var phase: Phase = .idle

    /// Where the server parked the photo. Survives a failed READ, because the
    /// server stages BEFORE it calls the model: a seller whose receipt could not
    /// be read still has the photo, and can still attach it by typing the
    /// details in. That is the difference between a degraded feature and a
    /// broken one.
    private(set) var stagingPath: String?

    private let service: ReceiptScanService

    init(service: ReceiptScanService = ReceiptScanService()) {
        self.service = service
    }

    var isScanning: Bool { phase == .scanning }

    /// The fields to pre-fill, or nil when nothing usable came back.
    var prefill: (category: ExpenseCategory, amountText: String, note: String, spentOn: Date)? {
        guard case let .done(result) = phase, result.readAnything else { return nil }
        return result.prefill()
    }

    /// Fields the model was unsure about, for the form to flag.
    var lowConfidenceFields: [String] {
        guard case let .done(result) = phase else { return [] }
        return result.lowConfidence
    }

    /// The server's own sentence, when it has one. Shown as received.
    var warning: String? {
        guard case let .done(result) = phase else { return nil }
        return result.warning
    }

    /// Read a photographed receipt.
    ///
    /// Compressed through ``PhotoCompressor`` rather than
    /// `jpegData(compressionQuality:)`: a raw encode records orientation as an
    /// EXIF flag that the server's metadata strip then removes, so a receipt
    /// photographed in landscape reaches the model sideways.
    /// `ios/Scripts/no-raw-jpeg-encode.py` is the gate.
    func scan(image: UIImage) async {
        phase = .scanning
        guard let compressed = await PhotoCompressor.compressOffMain(image) else {
            phase = .failed("Couldn't read that photo. Try taking it again.")
            return
        }
        do {
            let result = try await service.scan(imageData: compressed.imageData)
            stagingPath = result.stagingPath
            phase = .done(result)
        } catch {
            phase = .failed(
                FriendlyErrorCopy.actionMessage(
                    for: error,
                    fallback: "Couldn't read that receipt. Fill the details in and it will still be attached."
                )
            )
        }
    }

    /// Attach the staged photo to the expense that was just saved.
    ///
    /// BEST EFFORT, and it returns whether it worked rather than throwing. An
    /// expense with no receipt is a correct expense; blocking the save on the
    /// attach would turn a storage hiccup into a lost expense.
    @discardableResult
    func attach(toExpenseId expenseId: String) async -> Bool {
        guard let stagingPath else { return false }
        do {
            try await service.adoptStaged(
                expenseId: expenseId, stagingPath: stagingPath
            )
            self.stagingPath = nil
            return true
        } catch {
            return false
        }
    }

    func reset() {
        phase = .idle
        stagingPath = nil
    }
}
