import SwiftUI

/// US-2503 AC5: what the buyer bundle actually gives you ON THIS PHONE.
///
/// Every FlipDesk plan includes the buyer tools — that is what /pricing says and
/// it is true of the subscription. It has not been true of this app, which
/// shipped none of them and mentioned none of them, so a phone-only subscriber
/// paid for thirteen capabilities and could neither use them nor find out why.
///
/// This section says where each one lives. Three states and no fourth: in this
/// app, coming to this app, or somewhere else with the reason. A capability is
/// never silently dropped, because a bullet that vanishes on one client reads as
/// a bug rather than as a decision.
///
/// The table it renders is parity-tested against the web registry
/// (src/test/buyer-ios-capability-parity.test.ts), so a capability that becomes
/// available on the web cannot keep saying "coming soon" here by omission.
struct BuyerToolsSection: View {

    var body: some View {
        Section {
            ForEach(BuyerCapability.all) { capability in
                row(capability)
            }
        } header: {
            Text("Buyer tools, included with every plan")
        } footer: {
            Text("Buyer tools come with your FlipDesk plan at no extra cost. Some of them run in the desktop browser extension, where they can read the listing you are looking at.")
        }
    }

    private func row(_ capability: BuyerCapability) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Image(systemName: Self.icon(for: capability.delivery))
                    .foregroundStyle(Self.tint(for: capability.delivery))
                    .accessibilityHidden(true)
                Text(capability.label)
                    .font(.subheadline)
            }
            Text(Self.status(for: capability))
                .font(.caption)
                // Not a gray on a tinted surface: this rides the list background,
                // and .secondary tints from the foreground rather than sitting on
                // top of it as a flat gray.
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(capability.label). \(Self.status(for: capability))")
    }

    /// The one sentence under each capability. For a desktop-only capability it
    /// is the registry's own note, so web and iOS give the same reason rather
    /// than two paraphrases that drift.
    static func status(for capability: BuyerCapability) -> String {
        switch capability.delivery {
        case .shipped:
            return "Available in this app."
        case .planned:
            return "On the web today. Coming to iPhone."
        case .desktopOnly:
            return capability.note ?? "Runs in the desktop browser extension."
        }
    }

    private static func icon(for delivery: BuyerCapabilityDelivery) -> String {
        switch delivery {
        case .shipped: return "checkmark.circle.fill"
        case .planned: return "clock"
        case .desktopOnly: return "laptopcomputer"
        }
    }

    private static func tint(for delivery: BuyerCapabilityDelivery) -> Color {
        switch delivery {
        case .shipped: return Color.brandNavy
        case .planned, .desktopOnly: return .secondary
        }
    }
}
