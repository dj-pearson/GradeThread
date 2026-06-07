import SwiftUI

/// Skeleton placeholder mirroring ``GradeReportView``'s layout — shown while
/// the stored report loads, so the sheet has shape and motion instead of a
/// bare spinner.
struct GradeReportSkeleton: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                headerCard
                factorCard
                summaryCard
            }
            .padding(20)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading grade report")
    }

    private var headerCard: some View {
        HStack(spacing: 18) {
            SkeletonCircle(diameter: 96)
            VStack(alignment: .leading, spacing: 8) {
                SkeletonLine(widthFraction: 0.8, height: 16)
                SkeletonLine(widthFraction: 0.5, height: 12)
                SkeletonLine(widthFraction: 0.6, height: 12)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(.flush)
    }

    private var factorCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            SkeletonLine(widthFraction: 0.4, height: 13)
            ForEach(0..<5, id: \.self) { _ in
                VStack(alignment: .leading, spacing: 6) {
                    SkeletonLine(widthFraction: 0.55, height: 11)
                    SkeletonBlock(cornerRadius: 4).frame(height: 7)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(.flush)
    }

    private var summaryCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            SkeletonLine(widthFraction: 0.45, height: 13)
            SkeletonLine(widthFraction: 1, height: 11)
            SkeletonLine(widthFraction: 0.95, height: 11)
            SkeletonLine(widthFraction: 0.7, height: 11)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardStyle(.flush)
    }
}
