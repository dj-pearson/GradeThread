import SwiftUI

/// US-753: a shared label/value row so the `HStack { Text(label); Spacer();
/// Text(value) }` pattern that's scattered across Money / Sales / item detail
/// is declared once. The value uses the brand tabular-data font (monospaced
/// digits, US-654) so figures align down a column, and an optional tone tints
/// the value (e.g. brand red for a loss). An optional caption rides under the
/// value for secondary context ("net $X").
struct DataRow: View {
    let label: String
    let value: String
    var caption: String?
    var valueColor: Color = .primary
    var emphasis: Font.BrandDataWeight = .regular

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.sm) {
            Text(label)
                .font(.brandSubhead)
                .foregroundStyle(.secondary)
            Spacer(minLength: Spacing.xs)
            VStack(alignment: .trailing, spacing: 1) {
                Text(value)
                    .font(.brandData(15, weight: emphasis))
                    .foregroundStyle(valueColor)
                if let caption {
                    Text(caption)
                        .font(.brandCaption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        // Read the pair as one element to VoiceOver instead of two stray bits.
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
    }
}
