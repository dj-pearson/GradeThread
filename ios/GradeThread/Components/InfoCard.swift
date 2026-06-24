import SwiftUI

/// US-753: a shared titled card so screens stop hand-rolling the
/// "header over content" card (the UI audit counted ~40+ ad-hoc card
/// instances). Built on the design tokens (US-652) — it wraps `cardStyle()`
/// so the fill, radius, and inset stay identical everywhere — and adds an
/// optional title row with a leading SF Symbol, a subtitle, and a trailing
/// accessory slot.
///
/// Usage:
///   InfoCard("Payout") { DataRow(label: "Net", value: "$184") }
///   InfoCard("Listing", systemImage: "tag") { … } accessory: { StatusBadge(status: status) }
struct InfoCard<Content: View, Accessory: View>: View {
    let title: String?
    var subtitle: String?
    var systemImage: String?
    @ViewBuilder var content: () -> Content
    @ViewBuilder var accessory: () -> Accessory

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            if title != nil || subtitle != nil || hasAccessory {
                HStack(alignment: .firstTextBaseline, spacing: Spacing.xs) {
                    VStack(alignment: .leading, spacing: 2) {
                        if let title {
                            Label {
                                Text(title)
                            } icon: {
                                if let systemImage {
                                    Image(systemName: systemImage)
                                        .foregroundStyle(Color.brandNavy)
                                        // US-1202: decorative — don't let VoiceOver
                                        // read the SF Symbol name before the title.
                                        .accessibilityHidden(true)
                                }
                            }
                            .labelStyle(IconLeadingLabelStyle(hasIcon: systemImage != nil))
                            .font(.brandHeadline)
                            .foregroundStyle(Color.brandNavy)
                        }
                        if let subtitle {
                            Text(subtitle)
                                .font(.brandCaption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    if hasAccessory {
                        Spacer(minLength: Spacing.xs)
                        accessory()
                    }
                }
            }
            content()
        }
        .cardStyle()
    }

    private var hasAccessory: Bool {
        ObjectIdentifier(Accessory.self) != ObjectIdentifier(EmptyView.self)
    }
}

// MARK: - Convenience inits (no accessory)

extension InfoCard where Accessory == EmptyView {
    init(
        _ title: String? = nil,
        subtitle: String? = nil,
        systemImage: String? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.init(
            title: title,
            subtitle: subtitle,
            systemImage: systemImage,
            content: content,
            accessory: { EmptyView() }
        )
    }
}

extension InfoCard {
    init(
        _ title: String? = nil,
        subtitle: String? = nil,
        systemImage: String? = nil,
        @ViewBuilder content: @escaping () -> Content,
        @ViewBuilder accessory: @escaping () -> Accessory
    ) {
        self.title = title
        self.subtitle = subtitle
        self.systemImage = systemImage
        self.content = content
        self.accessory = accessory
    }
}

/// Keeps the icon snug to the title without the extra spacing SwiftUI's default
/// label inserts, and collapses cleanly when there's no icon.
private struct IconLeadingLabelStyle: LabelStyle {
    let hasIcon: Bool
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: hasIcon ? Spacing.xs : 0) {
            configuration.icon
            configuration.title
        }
    }
}

#Preview("InfoCard") {
    VStack(spacing: Spacing.md) {
        InfoCard("Payout", systemImage: "dollarsign.circle") {
            DataRow(label: "Gross", value: "$184.00")
            DataRow(label: "Fees", value: "−$24.10", valueColor: .brandRed)
            DataRow(label: "Net", value: "$159.90", emphasis: .bold)
        }
        InfoCard("Listing", systemImage: "tag") {
            DataRow(label: "Price", value: "$48.00")
        } accessory: {
            StatusBadge(status: "listed")
        }
    }
    .padding()
    .background(Color(uiColor: .systemGroupedBackground))
}
