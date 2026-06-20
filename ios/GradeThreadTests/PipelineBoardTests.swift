import XCTest
@testable import GradeThread

/// US-813: pure stage-move reducer + grouping for the inventory kanban board.
final class PipelineBoardTests: XCTestCase {

    /// Lightweight stand-in so the grouping tests don't need SwiftData.
    private struct Card { let id: String; let status: String }

    // MARK: - Column order (mirrors web FLIPDESK_PIPELINE)

    func test_columns_orderMatchesWebPipeline() {
        XCTAssertEqual(PipelineBoard.statusOrder, [
            "sourced", "cataloged", "measured", "photographed", "grading",
            "graded", "comped", "drafted", "listed", "sold", "shipped",
            "completed", "returned",
        ])
    }

    func test_columns_labelsAndNextActions() {
        XCTAssertEqual(PipelineBoard.columns.first?.label, "Sourced")
        XCTAssertEqual(PipelineBoard.columns.first?.nextAction, "Catalog basic info")
        XCTAssertEqual(PipelineBoard.columns.last?.status, "returned")
    }

    // MARK: - planMove reducer

    func test_planMove_noopWhenSameStatus() {
        XCTAssertNil(PipelineBoard.planMove(from: "sourced", to: "sourced"))
    }

    func test_planMove_noopWhenTargetNotAColumn() {
        XCTAssertNil(PipelineBoard.planMove(from: "sourced", to: "archived"))
        XCTAssertNil(PipelineBoard.planMove(from: "sourced", to: "keeping"))
        XCTAssertNil(PipelineBoard.planMove(from: "sourced", to: ""))
    }

    func test_planMove_forwardTransition() {
        XCTAssertEqual(
            PipelineBoard.planMove(from: "cataloged", to: "measured"),
            PipelineMove(from: "cataloged", to: "measured")
        )
    }

    func test_planMove_allowsBackwardTransition() {
        // The board enforces no ordering — a backward correction is a valid move.
        XCTAssertEqual(
            PipelineBoard.planMove(from: "listed", to: "drafted"),
            PipelineMove(from: "listed", to: "drafted")
        )
    }

    func test_planMove_retainsFromForRevert() {
        let move = PipelineBoard.planMove(from: "graded", to: "comped")
        XCTAssertEqual(move?.from, "graded")
        XCTAssertEqual(move?.to, "comped")
    }

    // MARK: - group

    func test_group_bucketsByStatusAndPreservesOrder() {
        let cards = [
            Card(id: "1", status: "sourced"),
            Card(id: "2", status: "measured"),
            Card(id: "3", status: "sourced"),
            Card(id: "4", status: "archived"), // off-pipeline → dropped
        ]
        let grouped = PipelineBoard.group(cards, status: \.status)
        XCTAssertEqual(grouped["sourced"]?.map(\.id), ["1", "3"])
        XCTAssertEqual(grouped["measured"]?.map(\.id), ["2"])
        XCTAssertNil(grouped["archived"], "off-pipeline status must not create a column")
    }

    func test_group_includesEveryColumnEvenWhenEmpty() {
        let grouped = PipelineBoard.group([Card(id: "1", status: "sold")], status: \.status)
        for status in PipelineBoard.statusOrder {
            XCTAssertNotNil(grouped[status], "missing column \(status)")
        }
        XCTAssertTrue(grouped["sourced"]?.isEmpty ?? false)
        XCTAssertEqual(grouped["sold"]?.count, 1)
    }

    func test_group_emptyInputYieldsAllEmptyColumns() {
        let grouped = PipelineBoard.group([Card](), status: \.status)
        XCTAssertEqual(grouped.count, PipelineBoard.statusOrder.count)
        XCTAssertTrue(grouped.values.allSatisfy { $0.isEmpty })
    }

    // MARK: - label

    func test_label_knownStatus() {
        XCTAssertEqual(PipelineBoard.label(for: "photographed"), "Photographed")
    }

    func test_label_unknownStatusFallsBackToTitleCase() {
        XCTAssertEqual(PipelineBoard.label(for: "to_list"), "To List")
    }
}
