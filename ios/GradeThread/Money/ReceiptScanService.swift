import Foundation

/// US-3014 AC3 — reading a receipt on the phone uses the SAME edge extraction
/// the web uses.
///
/// There is one prompt, one model, one set of confidence rules and one staging
/// boundary, and all of them live on the server. A second implementation here
/// would drift the first time either side was tuned, and the seller would get
/// two different answers from the same photo depending on which screen they
/// happened to be on. Android does this in `ReceiptScanService.kt` and this is
/// the same file in Swift.
///
/// So this is a TRANSPORT and nothing else. It does not decide what a receipt
/// says, does not score confidence, and does not write an expense: the model
/// proposes and the seller confirms (US-2993 AC1). That is not a formality — a
/// wrong number nobody looked at is worse than no number, because nobody checks
/// it a second time.
///
/// ⚠️ `EdgeAPI.aiShared`, NOT `EdgeAPI.shared`. Extraction is a vision call and
/// runs for tens of seconds with the connection legitimately idle the whole
/// time. On the 20-second-idle session it fails EVERY time in the worst way: the
/// server finishes the work, bills the seller's AI quota for it, and the app
/// shows a network error with nothing in the edge log to explain it.
/// `ios/Scripts/check-ai-session.py` enforces this.
struct ReceiptScanService {

    static let extractPath = "/api/flipdesk/expenses/extract"

    static func adoptPath(expenseId: String) -> String {
        "/api/flipdesk/expenses/\(expenseId)/adopt-staged"
    }

    private let api: EdgeAPI

    init(api: EdgeAPI = EdgeAPI.aiShared) {
        self.api = api
    }

    /// Send a photo to be read.
    ///
    /// The server stages the image and returns where it parked it. Nothing is
    /// attached to an expense until the seller confirms one, so an abandoned
    /// scan leaves a staged file and no ledger row — which is the right way
    /// round: a file nobody claims costs storage, a row nobody checked costs a
    /// wrong return.
    func scan(imageData: Data, mimeType: String = "image/jpeg") async throws -> ReceiptScanResult {
        // RAW bytes, then our own decoder. EdgeAPI's typed helper converts
        // snake_case, which rewrites the KEYS of the `confidence` map as well
        // as the coding keys — so `confidence["total_cents"]` arrived as
        // `confidence["totalCents"]` while `low_confidence`, an array of the
        // same names as values, kept the original spelling. Same reason the
        // other AI clients use `sendRaw`.
        let bytes = try await api.postMultipartImageRaw(
            Self.extractPath,
            fieldName: "receipt",
            fileName: "receipt.\(Self.fileExtension(for: mimeType))",
            mimeType: mimeType,
            data: imageData
        )
        return try Self.decode(bytes)
    }

    /// Decoding, separated so a test can drive it with real server bytes and no
    /// network. A plain decoder: every key here is spelled out in CodingKeys.
    static func decode(_ data: Data) throws -> ReceiptScanResult {
        do {
            return try JSONDecoder().decode(ReceiptScanResult.self, from: data)
        } catch {
            throw EdgeAPIError.decoding(error.localizedDescription)
        }
    }

    /// Attach a staged photo to the expense the seller has just confirmed.
    ///
    /// BEST EFFORT, and the caller must treat it that way. An expense with no
    /// receipt is a correct expense; a receipt with no expense is a file nobody
    /// ever finds. So the expense is saved first and this runs after.
    func adoptStaged(expenseId: String, stagingPath: String) async throws {
        struct Body: Encodable { let staging_path: String }
        let body = try JSONEncoder().encode(Body(staging_path: stagingPath))
        // The answer is `{ receipt_path }` and nothing reads it: the expense is
        // already saved and the row now carries the path. Discarding the bytes
        // is the honest version of that.
        _ = try await api.sendRaw(
            method: "POST",
            path: Self.adoptPath(expenseId: expenseId),
            bodyData: body
        )
    }

    /// Names the file sensibly in storage and nothing more. The server sniffs
    /// magic bytes and ignores what the client claims (US-276).
    static func fileExtension(for mimeType: String) -> String {
        switch mimeType.lowercased() {
        case "image/png": return "png"
        case "image/webp": return "webp"
        case "application/pdf": return "pdf"
        default: return "jpg"
        }
    }
}

/// One line the model read off a receipt.
struct ReceiptScanLine: Decodable, Equatable {
    let description: String?
    let amountCents: Int

    private enum CodingKeys: String, CodingKey {
        case description
        case amountCents = "amount_cents"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        amountCents = (try? c.decode(Int.self, forKey: .amountCents)) ?? 0
    }

    init(description: String?, amountCents: Int) {
        self.description = description
        self.amountCents = amountCents
    }
}

/// What the model proposed. Every field optional, because a blurred photo is a
/// normal outcome and a strict decoder would turn it into a crash.
struct ReceiptScanDraft: Decodable, Equatable {
    let vendor: String?
    /// A bare `YYYY-MM-DD`. Parsed through ``MoneyDate``, never anywhere else.
    let spentOn: String?
    let totalCents: Int?
    let taxCents: Int?
    let category: String?
    let lines: [ReceiptScanLine]

    private enum CodingKeys: String, CodingKey {
        case vendor, category, lines
        case spentOn = "spent_on"
        case totalCents = "total_cents"
        case taxCents = "tax_cents"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        vendor = try c.decodeIfPresent(String.self, forKey: .vendor)
        spentOn = try c.decodeIfPresent(String.self, forKey: .spentOn)
        totalCents = try c.decodeIfPresent(Int.self, forKey: .totalCents)
        taxCents = try c.decodeIfPresent(Int.self, forKey: .taxCents)
        category = try c.decodeIfPresent(String.self, forKey: .category)
        lines = (try? c.decode([ReceiptScanLine].self, forKey: .lines)) ?? []
    }

    init(
        vendor: String? = nil,
        spentOn: String? = nil,
        totalCents: Int? = nil,
        taxCents: Int? = nil,
        category: String? = nil,
        lines: [ReceiptScanLine] = []
    ) {
        self.vendor = vendor
        self.spentOn = spentOn
        self.totalCents = totalCents
        self.taxCents = taxCents
        self.category = category
        self.lines = lines
    }
}

/// The server's answer.
///
/// LENIENT ON PURPOSE. The server owns this contract and will grow fields; a
/// strict decoder here would turn every server improvement into a client crash.
struct ReceiptScanResult: Decodable, Equatable {
    /// Where the photo is parked until an expense exists to attach it to.
    /// ALWAYS present, even when the model read nothing — that is the guarantee
    /// the screen relies on to promise the seller their photo is safe.
    let stagingPath: String
    let draft: ReceiptScanDraft?
    let confidence: [String: Double]
    let lowConfidence: [String]
    /// Total less tax less the sum of the lines. Non-zero means a partial read.
    let linesGapCents: Int?
    let promptVersion: String?
    /// The server's own sentence when it has one. Shown as received: we did not
    /// write it and cannot localize it.
    let warning: String?

    private enum CodingKeys: String, CodingKey {
        case draft, confidence, warning
        case stagingPath = "staging_path"
        case lowConfidence = "low_confidence"
        case linesGapCents = "lines_gap_cents"
        case promptVersion = "prompt_version"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        stagingPath = try c.decode(String.self, forKey: .stagingPath)
        draft = try? c.decodeIfPresent(ReceiptScanDraft.self, forKey: .draft)
        confidence = (try? c.decode([String: Double].self, forKey: .confidence)) ?? [:]
        lowConfidence = (try? c.decode([String].self, forKey: .lowConfidence)) ?? []
        linesGapCents = try? c.decodeIfPresent(Int.self, forKey: .linesGapCents)
        promptVersion = try? c.decodeIfPresent(String.self, forKey: .promptVersion)
        warning = try? c.decodeIfPresent(String.self, forKey: .warning)
    }

    init(
        stagingPath: String,
        draft: ReceiptScanDraft? = nil,
        confidence: [String: Double] = [:],
        lowConfidence: [String] = [],
        linesGapCents: Int? = nil,
        promptVersion: String? = nil,
        warning: String? = nil
    ) {
        self.stagingPath = stagingPath
        self.draft = draft
        self.confidence = confidence
        self.lowConfidence = lowConfidence
        self.linesGapCents = linesGapCents
        self.promptVersion = promptVersion
        self.warning = warning
    }

    /// Whether the scan produced anything worth pre-filling.
    ///
    /// A blurred photo, a crumpled receipt and a model that simply could not
    /// read it are ONE outcome to the seller: type it in. Saying "the AI failed"
    /// invites a retry that will fail exactly the same way.
    var readAnything: Bool {
        draft?.totalCents != nil || draft?.vendor != nil
    }

    /// The prefill for the ordinary expense form.
    ///
    /// Every field the model was unsure about is still filled in — blanking one
    /// would make the seller retype something the model got right — and
    /// ``lowConfidence`` names the ones to look at.
    func prefill(now: Date = .now) -> (
        category: ExpenseCategory,
        amountText: String,
        note: String,
        spentOn: Date
    ) {
        let category = draft?.category
            .flatMap { ExpenseCategory(rawValue: $0) } ?? .other
        let amountText = draft?.totalCents.map { cents in
            String(format: "%d.%02d", cents / 100, abs(cents % 100))
        } ?? ""
        let spentOn = draft?.spentOn
            .flatMap { MoneyDate.parse($0) } ?? MoneyDate.today(now: now)
        return (category, amountText, draft?.vendor ?? "", spentOn)
    }

    /// Whether a field should be flagged for the seller to check.
    func needsALook(_ field: String) -> Bool {
        lowConfidence.contains(field)
    }
}
