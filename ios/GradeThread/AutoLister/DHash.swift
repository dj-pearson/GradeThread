import CoreGraphics
import Foundation
import UIKit

/// US-1548: 64-bit difference hash (dHash) for the AutoLister visual grouping
/// pass — the same perceptual hash the web computes in
/// `src/workers/image-compress.worker.ts`: downscale to 9×8 grayscale, then
/// each bit is "is this pixel brighter than its right neighbor". Two photos of
/// the same garment hash within a small Hamming distance even across angle /
/// crop changes; genuinely different items don't.
///
/// `compute` decodes + downsamples, so callers run it OFF the main thread
/// (the review model hashes during import, alongside compression).
enum DHash {
    /// Hash one image, or nil when it can't be drawn into a bitmap.
    static func compute(_ image: UIImage) -> UInt64? {
        guard let cgImage = image.cgImage else { return nil }
        let width = 9
        let height = 8
        var pixels = [UInt8](repeating: 0, count: width * height)
        guard let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return nil }
        context.interpolationQuality = .medium
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))

        var hash: UInt64 = 0
        for row in 0..<height {
            for col in 0..<(width - 1) {
                hash <<= 1
                if pixels[row * width + col] > pixels[row * width + col + 1] {
                    hash |= 1
                }
            }
        }
        return hash
    }

    /// Hamming distance between two 64-bit hashes (0…64).
    static func hammingDistance(_ a: UInt64, _ b: UInt64) -> Int {
        (a ^ b).nonzeroBitCount
    }
}
