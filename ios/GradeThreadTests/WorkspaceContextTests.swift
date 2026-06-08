import XCTest
@testable import GradeThread

/// US-670: active-workspace scoping logic.
@MainActor
final class WorkspaceContextTests: XCTestCase {

    override func setUp() {
        super.setUp()
        WorkspaceScope.clear()
    }

    override func tearDown() {
        WorkspaceScope.clear()
        super.tearDown()
    }

    // MARK: - WorkspaceScope

    func test_scope_defaultsToPersonal() {
        XCTAssertNil(WorkspaceScope.activeOwnerId)
        XCTAssertEqual(WorkspaceScope.tenantOwnerId(selfId: "self-1"), "self-1")
    }

    func test_scope_setAndClear() {
        WorkspaceScope.activeOwnerId = "owner-9"
        XCTAssertEqual(WorkspaceScope.activeOwnerId, "owner-9")
        XCTAssertEqual(WorkspaceScope.tenantOwnerId(selfId: "self-1"), "owner-9")
        WorkspaceScope.clear()
        XCTAssertNil(WorkspaceScope.activeOwnerId)
    }

    func test_scope_emptyStringIsTreatedAsPersonal() {
        WorkspaceScope.activeOwnerId = ""
        XCTAssertNil(WorkspaceScope.activeOwnerId)
    }

    // MARK: - WorkspaceContext

    func test_context_activeOwnerDefaultsToSelf() {
        let ctx = WorkspaceContext(selfUserId: "self-1")
        XCTAssertEqual(ctx.activeOwnerId, "self-1")
    }

    func test_context_switchTo_setsScopeAndPostsNotification() {
        let ctx = WorkspaceContext(selfUserId: "self-1")
        let exp = expectation(forNotification: .workspaceDidChange, object: nil)
        ctx.switchTo(ownerId: "owner-2")
        XCTAssertEqual(ctx.activeOwnerId, "owner-2")
        XCTAssertEqual(WorkspaceScope.activeOwnerId, "owner-2")
        wait(for: [exp], timeout: 1.0)
    }

    func test_context_switchBackToSelf_clearsScope() {
        WorkspaceScope.activeOwnerId = "owner-2"
        let ctx = WorkspaceContext(selfUserId: "self-1")
        ctx.switchTo(ownerId: "self-1")
        XCTAssertNil(WorkspaceScope.activeOwnerId)
        XCTAssertEqual(ctx.activeOwnerId, "self-1")
    }

    func test_context_switchTo_sameWorkspace_isNoOp() {
        let ctx = WorkspaceContext(selfUserId: "self-1")
        // No notification should fire when nothing changes.
        var fired = false
        let token = NotificationCenter.default.addObserver(
            forName: .workspaceDidChange, object: nil, queue: nil
        ) { _ in fired = true }
        defer { NotificationCenter.default.removeObserver(token) }
        ctx.switchTo(ownerId: "self-1")  // already personal
        XCTAssertFalse(fired)
    }
}
