import XCTest
@testable import GradeThread

/// `VerifiedStore` derived state + load/check/save flows (in-memory service).
@MainActor
final class VerifiedStoreTests: XCTestCase {

    private func makeResponse(
        handle: String? = "resale-rick",
        displayName: String? = "Resale Rick",
        bio: String? = "Vintage tees",
        enabled: Bool = true,
        since: String? = "2026-01-15T00:00:00.000Z",
        total: Int = 42,
        avg: Double = 7.8
    ) -> VerifiedProfileResponse {
        VerifiedProfileResponse(
            profile: VerifiedProfile(
                handle: handle, displayName: displayName, bio: bio,
                enabled: enabled, verifiedSince: since),
            stats: VerifiedStats(totalGraded: total, averageGrade: avg))
    }

    func test_load_appliesDraftsAndStats() async {
        let store = VerifiedStore(service: FakeVerifiedService(profile: makeResponse()))
        await store.load()
        XCTAssertEqual(store.phase, .ready)
        XCTAssertEqual(store.handleDraft, "resale-rick")
        XCTAssertEqual(store.displayNameDraft, "Resale Rick")
        XCTAssertEqual(store.bioDraft, "Vintage tees")
        XCTAssertTrue(store.enabled)
        XCTAssertEqual(store.stats?.totalGraded, 42)
    }

    func test_load_failedSurfacesError() async {
        let store = VerifiedStore(service: FakeVerifiedService(profileError: EdgeAPIError.network("offline")))
        await store.load()
        if case .failed = store.phase {} else { XCTFail("expected .failed") }
    }

    func test_publicProfileURL() async {
        let store = VerifiedStore(service: FakeVerifiedService(profile: makeResponse(handle: "rick")))
        await store.load()
        XCTAssertEqual(store.publicProfileURL?.absoluteString,
                       "https://gradethread.com/verified/rick")
    }

    func test_publicProfileURL_nilWithoutHandle() async {
        let store = VerifiedStore(service: FakeVerifiedService(profile: makeResponse(handle: nil, enabled: false)))
        await store.load()
        XCTAssertNil(store.publicProfileURL)
    }

    func test_noChanges_blocksSave() async {
        let store = VerifiedStore(service: FakeVerifiedService(profile: makeResponse()))
        await store.load()
        XCTAssertNil(store.pendingUpdate())
        XCTAssertFalse(store.hasChanges)
        XCTAssertFalse(store.canSave)
    }

    func test_bioChange_enablesSave() async {
        let store = VerifiedStore(service: FakeVerifiedService(profile: makeResponse()))
        await store.load()
        store.bioDraft = "Now selling denim"
        XCTAssertEqual(store.pendingUpdate()?.bio, "Now selling denim")
        XCTAssertTrue(store.canSave)
    }

    func test_overLimit_usesTrimmedLength() async {
        // US-1275: the over-limit check must use trimmed length (what's actually
        // sent), so a value at the limit plus trailing whitespace doesn't falsely
        // block save while exceeding the raw count.
        let store = VerifiedStore(service: FakeVerifiedService(profile: makeResponse()))
        await store.load()
        let atLimit = String(repeating: "a", count: VerifiedStore.maxBio)
        store.bioDraft = atLimit + "   "      // raw count over, trimmed at limit
        XCTAssertFalse(store.isBioOverLimit)
        XCTAssertTrue(store.canSave)
        store.bioDraft = atLimit + "b"        // genuinely over the limit
        XCTAssertTrue(store.isBioOverLimit)
        XCTAssertFalse(store.canSave)
    }

    func test_showListingsChange_enablesSave() async {
        let store = VerifiedStore(service: FakeVerifiedService(profile: makeResponse()))
        await store.load()
        XCTAssertFalse(store.showListings)
        store.showListings = true
        XCTAssertEqual(store.pendingUpdate()?.showListings, true)
        XCTAssertTrue(store.canSave)
    }

    func test_needsHandleToEnable_blocksSave() async {
        let store = VerifiedStore(service: FakeVerifiedService(profile: makeResponse(handle: nil, enabled: false)))
        await store.load()
        store.enabled = true
        XCTAssertTrue(store.needsHandleToEnable)
        XCTAssertFalse(store.canSave)
    }

    func test_invalidHandle_blocksSave() async {
        let store = VerifiedStore(service: FakeVerifiedService(profile: makeResponse()))
        await store.load()
        store.handleDraft = "ab" // too short
        XCTAssertNotNil(store.handleLocalError)
        XCTAssertFalse(store.canSave)
    }

    func test_checkAvailability_okAndTaken() async {
        let fake = FakeVerifiedService(profile: makeResponse(handle: "rick"))
        let store = VerifiedStore(service: fake)
        await store.load()

        store.handleDraft = "newhandle"
        await store.checkHandleAvailability()
        XCTAssertEqual(store.handleCheck, .ok)
        XCTAssertEqual(fake.lastCheckedHandle, "newhandle")

        fake.availabilityResult = .success(HandleAvailability(available: false, reason: "Taken!"))
        await store.checkHandleAvailability()
        XCTAssertEqual(store.handleCheck, .taken("Taken!"))
        XCTAssertFalse(store.canSave)
    }

    func test_checkAvailability_idleWhenUnchanged() async {
        let fake = FakeVerifiedService(profile: makeResponse(handle: "rick"))
        let store = VerifiedStore(service: fake)
        await store.load()
        await store.checkHandleAvailability() // draft == "rick"
        XCTAssertEqual(store.handleCheck, .idle)
        XCTAssertNil(fake.lastCheckedHandle) // no network call
    }

    func test_checkAvailability_invalidLocally() async {
        let fake = FakeVerifiedService(profile: makeResponse(handle: "rick"))
        let store = VerifiedStore(service: fake)
        await store.load()
        store.handleDraft = "bad handle!"
        await store.checkHandleAvailability()
        if case .invalid = store.handleCheck {} else { XCTFail("expected .invalid") }
        XCTAssertNil(fake.lastCheckedHandle)
    }

    func test_save_successAppliesAndClears() async {
        let fake = FakeVerifiedService(profile: makeResponse())
        fake.updateResult = .success(VerifiedProfile(
            handle: "resale-rick", displayName: "Resale Rick",
            bio: "Now selling denim", enabled: true, verifiedSince: "2026-01-15T00:00:00.000Z"))
        let store = VerifiedStore(service: fake)
        await store.load()
        store.bioDraft = "Now selling denim"

        let ok = await store.save()
        XCTAssertTrue(ok)
        XCTAssertEqual(fake.lastUpdate?.bio, "Now selling denim")
        XCTAssertEqual(store.original?.bio, "Now selling denim")
        XCTAssertEqual(store.handleCheck, .idle)
        XCTAssertFalse(store.hasChanges)
    }

    func test_save_errorSurfaces() async {
        let fake = FakeVerifiedService(profile: makeResponse())
        fake.updateResult = .failure(EdgeAPIError.badRequest(detail: "That handle is already taken."))
        let store = VerifiedStore(service: fake)
        await store.load()
        store.bioDraft = "changed"

        let ok = await store.save()
        XCTAssertFalse(ok)
        XCTAssertNotNil(store.saveError)
    }
}

private final class FakeVerifiedService: VerifiedProviding {
    var profileResult: Result<VerifiedProfileResponse, Error>
    var availabilityResult: Result<HandleAvailability, Error>
    var updateResult: Result<VerifiedProfile, Error>
    private(set) var lastUpdate: VerifiedProfileUpdate?
    private(set) var lastCheckedHandle: String?

    init(profile: VerifiedProfileResponse) {
        self.profileResult = .success(profile)
        self.availabilityResult = .success(HandleAvailability(available: true, reason: nil))
        self.updateResult = .success(profile.profile)
    }

    init(profileError: Error) {
        self.profileResult = .failure(profileError)
        self.availabilityResult = .success(HandleAvailability(available: true, reason: nil))
        self.updateResult = .failure(profileError)
    }

    func profile() async throws -> VerifiedProfileResponse { try profileResult.get() }

    func checkHandle(_ handle: String) async throws -> HandleAvailability {
        lastCheckedHandle = handle
        return try availabilityResult.get()
    }

    func update(_ body: VerifiedProfileUpdate) async throws -> VerifiedProfile {
        lastUpdate = body
        return try updateResult.get()
    }
}
