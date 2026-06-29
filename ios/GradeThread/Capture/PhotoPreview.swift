import SwiftUI
import UIKit

/// Full-screen preview of a captured photo. Tap a slot in the strip to
/// open this; user can keep, retake, or delete from here.
struct PhotoPreview: View {
    let slot: PhotoSlotType
    let capture: PhotoCapture
    let onRetake: () -> Void
    let onDelete: () -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let image = UIImage(data: capture.imageData) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .padding(.horizontal, 12)
            }

            VStack {
                HStack {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .scaledIconFont(size: 30)
                            .foregroundStyle(.white, .black.opacity(0.5))
                    }
                    .accessibilityLabel("Close")
                    .padding()

                    Spacer()

                    Text(slot.label)
                        .font(.brandHeadline)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(.black.opacity(0.4))
                        .clipShape(Capsule())
                        .padding()
                }

                Spacer()

                HStack(spacing: 16) {
                    Button(role: .destructive) {
                        onDelete()
                        dismiss()
                    } label: {
                        Label("Delete", systemImage: "trash")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(.red.opacity(0.85))
                            .foregroundStyle(.white)
                            .clipShape(RoundedRectangle(cornerRadius: CornerRadius.card, style: .continuous))
                    }

                    Button {
                        onRetake()
                        dismiss()
                    } label: {
                        Label("Retake", systemImage: "arrow.triangle.2.circlepath.camera")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(Color.brandNavy)
                            .foregroundStyle(.white)
                            .clipShape(RoundedRectangle(cornerRadius: CornerRadius.card, style: .continuous))
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 28)
            }
        }
    }
}
