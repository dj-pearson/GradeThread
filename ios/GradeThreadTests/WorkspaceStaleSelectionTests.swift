import XCTest
@testable import GradeThread

/// A member whose workspace access was revoked while the app was closed
/// relaunched still holding the other owner's data.
///
/// `WorkspaceContext.load()` noticed the stale selection and called
/// `WorkspaceScope.clear()`, which is a third of the job. `.workspaceDidChange`
/// is what invalidates the sync scope, flushes the tenant-keyed edge cache and
/// wipes the previous tenant's local rows (ContentView.swift:240). Without it
/// the app came up in the personal workspace with another owner's inventory,
/// sales and grades still in the local cache, shown as the user's own.
///
/// `switchTo` posts it. `handleAccessRevoked` posts it. `load()` was the one
/// path that changed the scope and did not, and it is also the only one that
/// runs when nobody is watching.
@MainActor
final class WorkspaceStaleSelectionTests: XCTestCase {

    private let mine = WorkspaceSummary(ownerId: "me", name: "My workspace", isPersonal: true)
    private let shared = WorkspaceSummary(ownerId: "owner-1", name: "Shared", isPersonal: false)

    override func tearDown() {
        WorkspaceScope.clear()
        super.tearDown()
    }

    // MARK: - The rule

    func test_aSelectionNotInTheListIsStale() {
        XCTAssertTrue(WorkspaceContext.isStaleSelection("owner-1", in: [mine]))
    }

    func test_aSelectionStillInTheListIsNot() {
        XCTAssertFalse(WorkspaceContext.isStaleSelection("owner-1", in: [mine, shared]))
    }

    func test_noSelectionIsNotStale() {
        // nil means the personal workspace, which is always reachable.
        XCTAssertFalse(WorkspaceContext.isStaleSelection(nil, in: [mine]))
        XCTAssertFalse(WorkspaceContext.isStaleSelection("", in: [mine]))
    }

    // MARK: - What dropping the scope has to do

    func test_droppingARevokedScopeAlsoRescopesAndTellsTheUser() {
        WorkspaceScope.activeOwnerId = "owner-1"
        var sawRescope = false
        var sawNotice = false
        let a = NotificationCenter.default.addObserver(
            forName: .workspaceDidChange, object: nil, queue: nil
        ) { _ in sawRescope = true }
        let b = NotificationCenter.default.addObserver(
            forName: .workspaceAccessRevoked, object: nil, queue: nil
        ) { _ in sawNotice = true }
        defer {
            NotificationCenter.default.removeObserver(a)
            NotificationCenter.default.removeObserver(b)
        }

        WorkspaceScope.handleAccessRevoked()

        XCTAssertNil(WorkspaceScope.activeOwnerId, "the scope is dropped")
        XCTAssertTrue(sawRescope, "and the local cache is told to wipe the old tenant's rows")
        XCTAssertTrue(sawNotice, "and the user is told why their workspace disappeared")
    }

    func test_clearAloneDoesNotRescope() {
        // This is the shape the bug had: the scope is gone and nothing else
        // knows. Pinned so the cheap-looking call is not put back.
        WorkspaceScope.activeOwnerId = "owner-1"
        var sawRescope = false
        let token = NotificationCenter.default.addObserver(
            forName: .workspaceDidChange, object: nil, queue: nil
        ) { _ in sawRescope = true }
        defer { NotificationCenter.default.removeObserver(token) }

        WorkspaceScope.clear()

        XCTAssertNil(WorkspaceScope.activeOwnerId)
        XCTAssertFalse(sawRescope, "clear() is the scope only — callers must not use it to drop a revoked workspace")
    }

    func test_droppingWhenThereWasNoSelectionIsANoOp() {
        WorkspaceScope.clear()
        var posted = false
        let token = NotificationCenter.default.addObserver(
            forName: .workspaceAccessRevoked, object: nil, queue: nil
        ) { _ in posted = true }
        defer { NotificationCenter.default.removeObserver(token) }

        WorkspaceScope.handleAccessRevoked()

        XCTAssertFalse(posted, "a personal-workspace user must not be told their access ended")
    }
}
