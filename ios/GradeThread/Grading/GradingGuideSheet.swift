import SwiftUI

/// "How grading works" explainer (US-818). A lightweight native sheet that
/// renders the five weighted condition factors (``GradeFactor``) and the
/// 1.0–10.0 tier scale, mirroring the web app's grading constants
/// (`src/lib/constants.ts`: `GRADE_FACTORS` + `GRADE_LABELS`). Native rather
/// than a Safari bounce so the education works offline and matches the in-app
/// grade report styling.
struct GradingGuideSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Every garment gets a single 1.0–10.0 grade, blended from five weighted factors. Higher means closer to new.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                Section {
                    ForEach(GradeFactor.allCases) { factor in
                        HStack(alignment: .firstTextBaseline) {
                            Text(factor.label)
                                .font(.subheadline.weight(.medium))
                            Spacer()
                            Text(Self.percent(factor.weight))
                                .font(.subheadline.monospacedDigit())
                                .foregroundStyle(.secondary)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("\(factor.label), \(Self.percent(factor.weight)) of the overall grade")
                    }
                } header: {
                    Text("The five factors")
                } footer: {
                    Text("Weights add up to 100%. Fabric and structural integrity carry the most weight because they affect how long a garment will last.")
                        .font(.footnote)
                }

                Section {
                    ForEach(Self.tiers, id: \.score) { tier in
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Text(tier.score)
                                .font(.subheadline.weight(.semibold).monospacedDigit())
                                .foregroundStyle(GradeScale.color(for: tier.colorScore))
                                .frame(width: 64, alignment: .leading)
                            Text(tier.label)
                                .font(.subheadline)
                            Spacer()
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("\(tier.score): \(tier.label)")
                    }
                } header: {
                    Text("The tier scale")
                } footer: {
                    Text("A grade below 0.75 confidence is routed to a human reviewer before it's certified.")
                        .font(.footnote)
                }
            }
            .navigationTitle("How grading works")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private static func percent(_ weight: Double) -> String {
        "\(Int((weight * 100).rounded()))%"
    }

    /// Human tier labels for the 1.0–10.0 scale. Mirrors `GRADE_LABELS` /
    /// `GRADE_TIERS` in `src/lib/constants.ts`. `colorScore` is the numeric
    /// midpoint used to tint the range via ``GradeScale/color(for:)``.
    private struct Tier {
        let score: String
        let label: String
        let colorScore: Double
    }

    private static let tiers: [Tier] = [
        Tier(score: "10",      label: "New with Tags (NWT)",       colorScore: 10),
        Tier(score: "9",       label: "New without Tags (NWOT)",   colorScore: 9.5),
        Tier(score: "8",       label: "Excellent",                 colorScore: 8),
        Tier(score: "7",       label: "Very Good",                 colorScore: 7),
        Tier(score: "6",       label: "Good",                      colorScore: 6),
        Tier(score: "5",       label: "Fair",                      colorScore: 5),
        Tier(score: "3–4",     label: "Poor",                      colorScore: 3.5),
        Tier(score: "1–2",     label: "Salvage / parts only",      colorScore: 1.5),
    ]
}

#Preview {
    GradingGuideSheet()
}
