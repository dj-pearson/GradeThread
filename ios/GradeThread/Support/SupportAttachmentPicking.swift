import PhotosUI
import SwiftUI
import UIKit

/// US-2561 — turning picked photos into what the endpoint accepts.
///
/// Separate from the views because both the composer and the reply box need the
/// identical behaviour, and "up to three" is a rule that has to hold across two
/// screens that each keep their own tray.
@MainActor
enum SupportAttachmentPicking {
    struct Result {
        let drafts: [SupportAttachmentDraft]
        /// Images the user picked and did not get, either because the tray was
        /// full or because the file could not be read. Reported so the tray can
        /// say so - silently dropping one is how a user sends a ticket missing
        /// the screenshot the whole ticket was about.
        let skipped: Int
    }

    /// Downscale and encode, stopping at `room`.
    ///
    /// The compression is the AC5 requirement and it is not a nicety: a 12MP
    /// photo base64-encodes to several megabytes, the body is JSON, and the
    /// difference is a support reply versus a timeout on a phone signal.
    static func drafts(from results: [PHPickerResult], room: Int) async -> Result {
        guard room > 0 else { return Result(drafts: [], skipped: results.count) }
        var out: [SupportAttachmentDraft] = []
        var skipped = 0
        for result in results {
            if out.count >= room {
                skipped += 1
                continue
            }
            guard let image = await result.loadImage(),
                  let output = await PhotoCompressor.compressOffMain(
                      image,
                      maxLongEdge: SupportAttachmentContract.maxLongEdge,
                      quality: SupportAttachmentContract.jpegQuality
                  )
            else {
                skipped += 1
                continue
            }
            out.append(
                SupportAttachmentDraft(
                    upload: SupportAttachmentUpload(
                        dataURL: SupportAttachmentContract.jpegDataURL(output.imageData),
                        // PhotoCompressor always emits JPEG, so the extension is
                        // not a guess. suggestedName carries the library's own
                        // name when it has one; safeAttachmentName on the server
                        // flattens anything hostile, and this only ever displays.
                        name: fileName(for: result)
                    ),
                    thumbnail: output.thumbnail
                )
            )
        }
        return Result(drafts: out, skipped: skipped)
    }

    static func fileName(for result: PHPickerResult) -> String {
        let suggested = result.itemProvider.suggestedName ?? ""
        let base = suggested.isEmpty ? "photo" : suggested
        return base.hasSuffix(".jpg") || base.hasSuffix(".jpeg") ? base : base + ".jpg"
    }
}

/// The staged-attachment strip shared by the composer and the reply box.
struct SupportAttachmentTray: View {
    @Binding var drafts: [SupportAttachmentDraft]
    var disabled: Bool

    var body: some View {
        if !drafts.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(drafts) { draft in
                        ZStack(alignment: .topTrailing) {
                            Image(uiImage: draft.thumbnail)
                                .resizable()
                                .scaledToFill()
                                .frame(width: 56, height: 56)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                            Button {
                                drafts.removeAll { $0.id == draft.id }
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .symbolRenderingMode(.palette)
                                    .foregroundStyle(.white, .black.opacity(0.6))
                            }
                            .disabled(disabled)
                            .accessibilityLabel("Remove attachment")
                            .padding(2)
                        }
                        .accessibilityElement(children: .contain)
                        .accessibilityLabel("Attached image")
                    }
                }
                .padding(.vertical, 4)
            }
        }
    }
}

/// One attachment on a message in the thread.
///
/// AC3's placeholder case is the interesting one and it is not a nil check. A
/// signed URL is a perfectly good string that stops working after ten minutes,
/// so a thread left open while the user takes a call has dead images and nothing
/// about the value says so. `fetchedAt` is when the GET that produced it
/// returned; past the TTL this renders a tappable placeholder that reloads the
/// thread rather than a broken-image glyph.
struct SupportAttachmentImage: View {
    let attachment: SupportAttachmentView
    let fetchedAt: Date
    let reload: () async -> Void

    @State private var now: Date = .now

    private var usable: Bool {
        SupportAttachmentContract.isURLUsable(attachment.url, fetchedAt: fetchedAt, now: now)
    }

    var body: some View {
        Group {
            if usable, let url = attachment.url.flatMap(URL.init(string:)) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case let .success(image):
                        image.resizable().scaledToFill()
                    case .failure:
                        // The URL looked live and the fetch failed anyway -
                        // treat it the same as expired rather than showing the
                        // system's broken glyph.
                        expired
                    default:
                        ProgressView()
                    }
                }
            } else {
                expired
            }
        }
        .frame(width: 88, height: 88)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityLabel(attachment.name)
        // Re-evaluating on a timer rather than only on appear: the common case
        // is a thread that was open when the link died.
        .task {
            while !Task.isCancelled {
                now = .now
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }

    private var expired: some View {
        Button {
            Task { await reload() }
        } label: {
            VStack(spacing: 4) {
                Image(systemName: "arrow.clockwise")
                Text("Reload")
                    .font(.caption2)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.secondary.opacity(0.12))
            .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Image link expired, tap to reload")
    }
}
