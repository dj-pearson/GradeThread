import UIKit

/// Composites an annotated defect photo with `UIGraphicsImageRenderer`: the
/// downscaled photo, a numbered callout box per localized defect, and a legend
/// strip beneath listing every annotation. Mirrors the web `annotated-photo.tsx`.
/// Geometry/colors come from `DisclosureGeometry` (pure + unit-tested); this file
/// is the thin drawing layer (not unit-tested — verified visually).
enum DisclosureRenderer {

    static func render(image: UIImage, annotations: [PhotoAnnotation]) -> UIImage {
        let canvas = DisclosureGeometry.canvasSize(imageSize: image.size)
        guard canvas.width > 0, canvas.height > 0 else { return image }
        let total = DisclosureGeometry.compositeSize(
            imageSize: image.size, annotationCount: annotations.count
        )

        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: total, format: format)

        return renderer.image { ctx in
            let cg = ctx.cgContext
            // White backdrop so the legend reads; the photo covers the top region.
            UIColor.white.setFill()
            cg.fill(CGRect(origin: .zero, size: total))
            image.draw(in: CGRect(origin: .zero, size: canvas))

            for ann in annotations {
                guard let bbox = ann.bbox,
                      let rect = DisclosureGeometry.scaledRect(bbox: bbox, in: canvas) else { continue }
                drawCallout(in: rect, number: ann.n,
                            color: DisclosureSeverityColor.color(for: ann.severity),
                            canvasWidth: canvas.width)
            }

            drawLegend(annotations, y: canvas.height, width: canvas.width)
        }
    }

    /// PNG data URL for `POST /annotated-photo`.
    static func dataURL(for image: UIImage) -> String? {
        guard let png = image.pngData() else { return nil }
        return "data:image/png;base64,\(png.base64EncodedString())"
    }

    // MARK: - Drawing

    private static func drawCallout(in rect: CGRect, number: Int, color: UIColor, canvasWidth: CGFloat) {
        let box = UIBezierPath(roundedRect: rect, cornerRadius: max(4, rect.width * 0.06))
        box.lineWidth = max(2, canvasWidth / 250)
        color.setStroke()
        box.stroke()

        let r = max(11, canvasWidth / 45)
        let badge = CGRect(x: rect.minX - r, y: rect.minY - r, width: r * 2, height: r * 2)
        color.setFill()
        UIBezierPath(ovalIn: badge).fill()
        drawText("\(number)", in: badge, font: .boldSystemFont(ofSize: r),
                 color: .white, alignment: .center)
    }

    private static func drawLegend(_ annotations: [PhotoAnnotation], y: CGFloat, width: CGFloat) {
        guard !annotations.isEmpty else { return }
        let pad = DisclosureGeometry.legendPadding
        let lineH = DisclosureGeometry.legendLineHeight
        let font = UIFont.systemFont(ofSize: max(13, width / 60))
        let navy = UIColor(red: 0.047, green: 0.118, blue: 0.212, alpha: 1)
        var lineY = y + pad

        for ann in annotations {
            let dot = CGFloat(7)
            let dotRect = CGRect(x: pad, y: lineY + (lineH - dot * 2) / 2, width: dot * 2, height: dot * 2)
            DisclosureSeverityColor.color(for: ann.severity).setFill()
            UIBezierPath(ovalIn: dotRect).fill()
            drawText("\(ann.n)", in: dotRect, font: .boldSystemFont(ofSize: 9),
                     color: .white, alignment: .center)

            let loc = (ann.location?.isEmpty == false) ? " (\(ann.location!))" : ""
            let text = "\(ann.issue)\(loc) — \(ann.severity)"
            let textX = pad + dot * 2 + 8
            let textRect = CGRect(x: textX, y: lineY, width: width - textX - pad, height: lineH)
            drawText(text, in: textRect, font: font, color: navy, alignment: .left, truncating: true)
            lineY += lineH
        }
    }

    private static func drawText(
        _ s: String, in rect: CGRect, font: UIFont, color: UIColor,
        alignment: NSTextAlignment, truncating: Bool = false
    ) {
        let para = NSMutableParagraphStyle()
        para.alignment = alignment
        if truncating { para.lineBreakMode = .byTruncatingTail }
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font, .foregroundColor: color, .paragraphStyle: para,
        ]
        let size = (s as NSString).size(withAttributes: attrs)
        let drawRect = CGRect(
            x: alignment == .center ? rect.midX - size.width / 2 : rect.minX,
            y: rect.midY - size.height / 2,
            width: alignment == .center ? size.width : rect.width,
            height: size.height
        )
        (s as NSString).draw(in: drawRect, withAttributes: attrs)
    }
}
