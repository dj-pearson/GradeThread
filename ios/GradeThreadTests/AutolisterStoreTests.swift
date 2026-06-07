import XCTest
@testable import GradeThread

/// `AutolisterBatchStore` lifecycle + the wire-contract decode. Uses an in-memory
/// fake service (no network) and drives the poll/terminalize steps directly so
/// no real timers are involved.
@MainActor
final class AutolisterStoreTests: XCTestCase {

    // MARK: - Decode contract (real EdgeAPI decoder: snake_case + ISO-8601)

    func test_decodesBatchStatus_snakeCaseAndEnums() throws {
        let json = #"""
        {
          "batch": {
            "id": "b1", "status": "running", "source": "autolister",
            "item_count": 2, "succeeded_count": 1, "failed_count": 0,
            "error": null,
            "created_at": "2026-06-06T00:00:00.123Z",
            "updated_at": "2026-06-06T00:01:00.000Z"
          },
          "jobs": [
            {"id":"j1","inventory_item_id":"it1","status":"success","error":null,
             "attempts":1,"listing_id":"L1","updated_at":"2026-06-06T00:01:00Z"},
            {"id":"j2","inventory_item_id":"it2","status":"pending","error":null,
             "attempts":0,"listing_id":null,"updated_at":"2026-06-06T00:00:30Z"}
          ]
        }
        """#
        let res = try JSONDecoder.iso8601.decode(BatchStatusResponse.self, from: Data(json.utf8))
        XCTAssertEqual(res.batch.itemCount, 2)
        XCTAssertEqual(res.batch.succeededCount, 1)
        XCTAssertEqual(res.batch.status, .running)
        XCTAssertEqual(res.jobs.count, 2)
        XCTAssertEqual(res.jobs[0].inventoryItemId, "it1")
        XCTAssertEqual(res.jobs[0].status, .success)
        XCTAssertEqual(res.jobs[0].listingId, "L1")
        XCTAssertNil(res.jobs[1].listingId)
    }

    func test_decodesPhotoQa() throws {
        let json = #"""
        {"results":[
          {"item_id":"it1","score":82,"issues":[],"error":null},
          {"item_id":"it2","score":40,"issues":[
             {"type":"blurry","severity":"high","message":"Reshoot the front","photo_index":0}
          ]}
        ]}
        """#
        let res = try JSONDecoder.iso8601.decode(PhotoQaResponse.self, from: Data(json.utf8))
        XCTAssertEqual(res.results.count, 2)
        XCTAssertEqual(res.results[1].itemId, "it2")
        XCTAssertEqual(res.results[1].issues.first?.photoIndex, 0)
        XCTAssertEqual(res.results[1].issues.first?.severity, "high")
    }

    func test_decodesClassify_preservesPhotoIdKeys() throws {
        let json = #"{"cover_id":"p2","roles":{"p1":"detail","p2":"front","p3":"tag"}}"#
        let res = try JSONDecoder.iso8601.decode(ClassifyPhotosResponse.self, from: Data(json.utf8))
        XCTAssertEqual(res.coverId, "p2")
        XCTAssertEqual(res.roles["p2"], "front")
        XCTAssertEqual(res.roles.count, 3)
    }

    // MARK: - apply / phase mapping (pure)

    func test_apply_runningKeepsPolling() {
        let store = AutolisterBatchStore(service: FakeAutolisterService())
        store.apply(Self.statusResponse(.running, succeeded: 0, failed: 0))
        XCTAssertEqual(store.phase, .running)
        XCTAssertFalse(store.isTerminal)
    }

    func test_apply_completedIsTerminal() {
        let store = AutolisterBatchStore(service: FakeAutolisterService())
        store.apply(Self.statusResponse(.completed, succeeded: 2, failed: 0))
        XCTAssertEqual(store.phase, .completed)
        XCTAssertTrue(store.isTerminal)
        XCTAssertEqual(store.progress, 1, accuracy: 0.001)
    }

    func test_apply_partialMapsToPartial_andFlagsFailures() {
        let store = AutolisterBatchStore(service: FakeAutolisterService())
        store.apply(Self.statusResponse(.partial, succeeded: 1, failed: 1))
        XCTAssertEqual(store.phase, .partial)
        XCTAssertTrue(store.hasFailures)
    }

    func test_apply_failedCarriesError() {
        let store = AutolisterBatchStore(service: FakeAutolisterService())
        store.apply(Self.statusResponse(.failed, succeeded: 0, failed: 0, error: "boom"))
        XCTAssertEqual(store.phase, .failed("boom"))
    }

    // MARK: - submit / poll / retry (mock service)

    func test_submit_setsBatchIdAndPolls() async {
        let fake = FakeAutolisterService()
        fake.startResult = StartBatchResponse(batchId: "B9", itemCount: 3)
        let store = AutolisterBatchStore(service: fake)
        await store.submit(itemIds: ["a", "b", "c"])
        store.stop() // cancel the background poll before it races our asserts
        XCTAssertEqual(store.batchId, "B9")
        XCTAssertEqual(fake.startCalls, 1)
        XCTAssertEqual(store.phase, .running)
    }

    func test_submit_forwardsTemplateId() async {
        // US-674: a chosen template id reaches the edge client.
        let fake = FakeAutolisterService()
        fake.startResult = StartBatchResponse(batchId: "B7", itemCount: 1)
        let store = AutolisterBatchStore(service: fake)
        await store.submit(itemIds: ["a"], templateId: "tpl-123")
        store.stop()
        XCTAssertEqual(fake.lastTemplateId, "tpl-123")
    }

    func test_submit_defaultTemplateIsNil() async {
        let fake = FakeAutolisterService()
        fake.startResult = StartBatchResponse(batchId: "B8", itemCount: 1)
        let store = AutolisterBatchStore(service: fake)
        await store.submit(itemIds: ["a"])
        store.stop()
        XCTAssertNil(fake.lastTemplateId)
    }

    func test_submit_emptyIsNoop() async {
        let fake = FakeAutolisterService()
        let store = AutolisterBatchStore(service: fake)
        await store.submit(itemIds: [])
        XCTAssertEqual(fake.startCalls, 0)
        XCTAssertEqual(store.phase, .idle)
    }

    func test_submit_failureSurfacesError() async {
        let fake = FakeAutolisterService()
        fake.errorToThrow = EdgeAPIError.rateLimited
        let store = AutolisterBatchStore(service: fake)
        await store.submit(itemIds: ["a"])
        XCTAssertNotNil(store.errorMessage)
        if case .failed = store.phase {} else { XCTFail("expected .failed phase") }
    }

    func test_pollOnce_appliesStatusAndReportsTerminal() async {
        let fake = FakeAutolisterService()
        fake.startResult = StartBatchResponse(batchId: "B1", itemCount: 1)
        fake.statusResult = Self.statusResponse(.completed, succeeded: 1, failed: 0)
        let store = AutolisterBatchStore(service: fake)
        await store.submit(itemIds: ["a"])
        store.stop()
        let terminal = await store.pollOnce()
        XCTAssertTrue(terminal)
        XCTAssertEqual(store.phase, .completed)
        XCTAssertEqual(store.jobs.count, 1)
    }

    func test_retryFailed_callsServiceAndResumes() async {
        let fake = FakeAutolisterService()
        fake.startResult = StartBatchResponse(batchId: "B1", itemCount: 2)
        let store = AutolisterBatchStore(service: fake)
        await store.submit(itemIds: ["a", "b"])
        store.stop()
        await store.retryFailed()
        store.stop()
        XCTAssertEqual(fake.retryCalls, 1)
        XCTAssertEqual(store.phase, .running)
    }

    func test_runPhotoQa_populatesByItemId() async {
        let fake = FakeAutolisterService()
        fake.qaResult = PhotoQaResponse(results: [
            PhotoQaResult(itemId: "it1", score: 90, issues: [], error: nil),
            PhotoQaResult(itemId: "it2", score: 30, issues: [], error: nil),
        ])
        let store = AutolisterBatchStore(service: fake)
        await store.runPhotoQa(itemIds: ["it1", "it2"])
        XCTAssertEqual(store.photoQa["it2"]?.score, 30)
        XCTAssertEqual(store.photoQa.count, 2)
    }

    // MARK: - Fixtures

    private static func statusResponse(
        _ status: AutolisterBatchStatus,
        succeeded: Int,
        failed: Int,
        error: String? = nil
    ) -> BatchStatusResponse {
        BatchStatusResponse(
            batch: AutolisterBatch(
                id: "b1", status: status, source: "autolister",
                itemCount: 2, succeededCount: succeeded, failedCount: failed,
                error: error, createdAt: nil, updatedAt: nil
            ),
            jobs: [
                AutolisterJob(id: "j1", inventoryItemId: "it1",
                              status: failed > 0 ? .failed : .success,
                              error: nil, attempts: 1, listingId: "L1", updatedAt: nil),
            ]
        )
    }
}

/// In-memory `AutolisterBatching` for the store tests. Plain (non-isolated)
/// class; only ever touched on the MainActor by the @MainActor store + test.
private final class FakeAutolisterService: AutolisterBatching {
    var startResult = StartBatchResponse(batchId: "b1", itemCount: 1)
    var statusResult = BatchStatusResponse(
        batch: AutolisterBatch(id: "b1", status: .running, source: nil,
                               itemCount: 1, succeededCount: 0, failedCount: 0,
                               error: nil, createdAt: nil, updatedAt: nil),
        jobs: []
    )
    var retryResult = RetryFailedResponse(batchId: "b1", retried: 1)
    var classifyResult = ClassifyPhotosResponse(coverId: nil, roles: [:])
    var qaResult = PhotoQaResponse(results: [])
    var errorToThrow: Error?

    private(set) var startCalls = 0
    private(set) var statusCalls = 0
    private(set) var retryCalls = 0
    private(set) var qaCalls = 0
    /// US-674: records the template id passed to the most recent startBatch.
    private(set) var lastTemplateId: String?

    func startBatch(itemIds: [String], useComps: Bool, templateId: String?) async throws -> StartBatchResponse {
        startCalls += 1
        lastTemplateId = templateId
        if let errorToThrow { throw errorToThrow }
        return startResult
    }
    func batchStatus(batchId: String) async throws -> BatchStatusResponse {
        statusCalls += 1
        if let errorToThrow { throw errorToThrow }
        return statusResult
    }
    func retryFailed(batchId: String) async throws -> RetryFailedResponse {
        retryCalls += 1
        if let errorToThrow { throw errorToThrow }
        return retryResult
    }
    func classifyPhotos(_ photos: [ClassifyPhotoInput]) async throws -> ClassifyPhotosResponse {
        if let errorToThrow { throw errorToThrow }
        return classifyResult
    }
    func photoQa(itemIds: [String]) async throws -> PhotoQaResponse {
        qaCalls += 1
        if let errorToThrow { throw errorToThrow }
        return qaResult
    }
}
