import CoreImage
import CoreImage.CIFilterBuiltins
import UIKit

/// Generates and AirPrints SKU / barcode labels for an inventory item (US-676).
///
/// The barcode is a Code 128 symbology (the same family the intake
/// ``BarcodeScanner`` reads back), rendered with CoreImage and composited with
/// the SKU + a short title into a 2"×1" label image. Printing goes through
/// `UIPrintInteractionController`, which surfaces the system AirPrint sheet —
/// no third-party SDK, works with any AirPrint-capable label printer.
@MainActor
enum LabelPrinter {

    enum LabelError: LocalizedError, Equatable {
        case emptySKU
        case barcodeFailed
        var errorDescription: String? {
            switch self {
            case .emptySKU: return "This item has no SKU to print."
            case .barcodeFailed: return "Couldn't generate the barcode."
            }
        }
    }

    /// 2"×1" at 300 dpi — a common thermal label size.
    static let labelSize = CGSize(width: 600, height: 300)

    /// Renders a Code 128 barcode for `value` as a crisp (non-interpolated)
    /// UIImage. Returns nil if the value can't be encoded.
    static func barcodeImage(from value: String) -> UIImage? {
        let data = Data(value.utf8)
        guard !data.isEmpty else { return nil }
        let filter = CIFilter.code128BarcodeGenerator()
        filter.message = data
        filter.quietSpace = 4
        guard let output = filter.outputImage else { return nil }
        // Scale up so the bars stay sharp when drawn into the label.
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 4, y: 4))
        let context = CIContext()
        guard let cg = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cg)
    }

    /// Composites the barcode + SKU + title into a single printable label image.
    static func makeLabelImage(sku: String, title: String?) throws -> UIImage {
        let trimmedSKU = sku.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedSKU.isEmpty else { throw LabelError.emptySKU }
        guard let barcode = barcodeImage(from: trimmedSKU) else { throw LabelError.barcodeFailed }

        let renderer = UIGraphicsImageRenderer(size: labelSize)
        return renderer.image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: labelSize))

            // Title (optional) across the top.
            var y: CGFloat = 12
            if let title, !title.isEmpty {
                let titleAttrs: [NSAttributedString.Key: Any] = [
                    .font: UIFont.boldSystemFont(ofSize: 32),
                    .foregroundColor: UIColor.black,
                ]
                let truncated = title.count > 28 ? String(title.prefix(27)) + "…" : title
                truncated.draw(
                    in: CGRect(x: 16, y: y, width: labelSize.width - 32, height: 40),
                    withAttributes: titleAttrs
                )
                y += 46
            }

            // Barcode fills the middle band, preserving aspect ratio.
            let barcodeAreaHeight = labelSize.height - y - 46
            let aspect = barcode.size.width / max(barcode.size.height, 1)
            var bw = labelSize.width - 32
            var bh = bw / aspect
            if bh > barcodeAreaHeight {
                bh = barcodeAreaHeight
                bw = bh * aspect
            }
            let bx = (labelSize.width - bw) / 2
            barcode.draw(in: CGRect(x: bx, y: y, width: bw, height: bh))

            // SKU text along the bottom.
            let skuAttrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.monospacedSystemFont(ofSize: 30, weight: .semibold),
                .foregroundColor: UIColor.black,
            ]
            let skuSize = (trimmedSKU as NSString).size(withAttributes: skuAttrs)
            trimmedSKU.draw(
                at: CGPoint(x: (labelSize.width - skuSize.width) / 2, y: labelSize.height - 40),
                withAttributes: skuAttrs
            )
        }
    }

    /// Presents the system AirPrint sheet for the item's SKU label.
    /// Throws ``LabelError`` if the label can't be built.
    static func printLabel(sku: String, title: String?) throws {
        let image = try makeLabelImage(sku: sku, title: title)

        let info = UIPrintInfo.printInfo()
        info.outputType = .grayscale
        info.jobName = "SKU \(sku)"

        let controller = UIPrintInteractionController.shared
        controller.printInfo = info
        controller.printingItem = image
        controller.present(animated: true, completionHandler: nil)
    }
}
