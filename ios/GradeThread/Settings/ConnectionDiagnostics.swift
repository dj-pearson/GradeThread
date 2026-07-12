import Foundation

/// One-shot connection probe used by the Settings diagnostics section.
/// Runs the *exact same* `SupabaseShared.client` the app uses, and reports
/// the raw outcome of a session read, a few table selects, and a storage
/// write — so an empty screen / failed upload can be traced to its cause:
///   • session error            → auth/token problem
///   • table returns `[]`        → RLS returns 0 rows for this user
///   • table returns `[{…}]`     → data flows; the sync merge is the bug
///   • table throws (401/perm…)  → the error is printed verbatim
///   • storage HTTP 4xx          → why photo upload fails
@MainActor
struct ConnectionDiagnostics {
    func run(localItemCount: Int) async -> String {
        var lines: [String] = []

        // How many rows actually made it into the on-device SwiftData store
        // (what the Home/Inventory/Money views @Query). If this is 0 while the
        // server returns rows, the merge — not the network — is the problem.
        lines.append("local SwiftData cache: \(localItemCount) items")

        // Config actually baked into this build.
        lines.append("supabase: \(AppConfig.supabaseURL.absoluteString)")
        lines.append("anon key: \(AppConfig.supabaseAnonKey.isEmpty ? "MISSING" : "present (\(AppConfig.supabaseAnonKey.count) chars)")")

        // Session
        var userId: String?
        lines.append("")
        lines.append("— session —")
        do {
            let session = try await SupabaseShared.client.auth.session
            userId = session.user.id.uuidString
            lines.append("user_id: \(session.user.id.uuidString)")
            // Security (audit 2026-06-24): email omitted — user_id is enough to
            // trace an RLS / empty-data issue, and this output is copyable. The
            // section is also internal-build-only (see DiagnosticsSection).
            lines.append("token: present (\(session.accessToken.prefix(6))…)")
            lines.append("expires_at: \(session.expiresAt)")
        } catch {
            lines.append("SESSION ERROR: \(error.localizedDescription)")
            lines.append(String(reflecting: error).prefix(400).description)
        }

        for table in ["inventory_items", "item_photos", "sales"] {
            lines.append("")
            lines.append("— \(table) —")
            await probeTable(table, into: &lines)
        }

        lines.append("")
        lines.append("— full pull (real columns + decode) —")
        await probeFullPull(into: &lines)

        lines.append("")
        lines.append("— storage write (legacy direct path) —")
        await probeStorage(userId: userId, into: &lines)

        lines.append("")
        lines.append("— signed-upload mint + PUT (the REAL upload path) —")
        await probeUploadMint(userId: userId, into: &lines)

        lines.append("")
        lines.append("— item_photos INSERT (the real DB-link step) —")
        await probeItemPhotoLink(userId: userId, into: &lines)

        return lines.joined(separator: "\n")
    }

    /// Minimal valid 1x1 JPEG — the exact content-type a real upload sends.
    /// `static` so both storage probes share the one literal.
    static let probeJPEG: Data = Data(base64Encoded:
        "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAC//EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AfwD/2Q=="
    ) ?? Data()

    /// Runs the exact full-column select the sync engine uses + the resilient
    /// decoder, so the output confirms whether rows actually decode into items.
    private func probeFullPull(into lines: inout [String]) async {
        let columns = "id,user_id,title,brand,sku,size,color,material,status,target_price,acquired_price,grade_value,grade_label,certificate_url,condition_notes,measurements,created_at,updated_at"
        do {
            let response = try await SupabaseShared.client
                .from("inventory_items")
                .select(columns)
                .limit(50)
                .execute()
            let decoded = SyncEngine.decodeItemsResiliently(response.data)
            lines.append("select OK \(response.data.count)b → decoded \(decoded.count) items")
            if let first = decoded.first {
                lines.append("first: \(first.title) [\(first.status)]")
            }
        } catch {
            lines.append("FULL PULL ERROR: \(error.localizedDescription)")
            lines.append(String(reflecting: error).prefix(400).description)
        }
    }

    /// PostgREST read — supabase-swift attaches the session token automatically.
    private func probeTable(_ table: String, into lines: inout [String]) async {
        do {
            let response = try await SupabaseShared.client
                .from(table)
                .select("id")
                .limit(3)
                .execute()
            let raw = String(data: response.data, encoding: .utf8)
                ?? "<non-utf8 \(response.data.count) bytes>"
            lines.append("OK \(response.data.count)b: \(raw.prefix(300))")
        } catch {
            lines.append("ERROR: \(error.localizedDescription)")
            lines.append(String(reflecting: error).prefix(400).description)
        }
    }

    /// Replicates ``PhotoUploadService``'s manual Storage request so an upload
    /// failure surfaces as a concrete HTTP status + body. Uploads a tiny REAL
    /// JPEG with `image/jpeg` (not text/plain) so it actually exercises what a
    /// photo upload does — the buckets enforce an image-only MIME allowlist, so
    /// a text probe always 415s and never tests the true path. Cleans up after.
    private func probeStorage(userId: String?, into lines: inout [String]) async {
        guard let userId else { lines.append("skipped: no user id"); return }
        guard let token = await SupabaseShared.currentAccessToken() else {
            lines.append("no access token (currentAccessToken returned nil)")
            return
        }
        let jpeg = Self.probeJPEG
        let path = "/storage/v1/object/item-photos/\(userId.lowercased())/diagnostics/probe.jpg"
        guard var components = URLComponents(url: AppConfig.supabaseURL, resolvingAgainstBaseURL: false) else {
            lines.append("bad supabase url"); return
        }
        components.path = path
        guard let url = components.url else { lines.append("bad storage url"); return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        request.setValue("true", forHTTPHeaderField: "x-upsert")
        request.httpBody = jpeg

        do {
            // Bounded session (US-992): a connectivity probe must fail fast
            // rather than hang ~60s on URLSession.shared's default timeout.
            let (data, response) = try await EdgeNetwork.shared.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? -1
            let body = String(data: data, encoding: .utf8)?.prefix(200) ?? ""
            lines.append("image upload HTTP \(code): \(body.isEmpty ? "(ok)" : String(body))")

            // Best-effort cleanup so the probe object doesn't linger.
            if (200..<300).contains(code) {
                var del = URLRequest(url: url)
                del.httpMethod = "DELETE"
                del.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                del.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
                _ = try? await EdgeNetwork.shared.data(for: del)
            }
        } catch {
            lines.append("ERROR: \(error.localizedDescription)")
        }
    }

    /// Probes the SIGNED-UPLOAD path the app actually uses (US-1219): mint a
    /// signed upload URL, then PUT the bytes. The `storage write` probe above
    /// does NOT exercise this — it uses the legacy direct POST — so it can read
    /// 200 while real photo uploads fail. Runs the mint BOTH ways: the shipped
    /// build sent an empty application/json body, which storage-api (Fastify)
    /// 400s (FST_ERR_CTP_EMPTY_JSON_BODY); the `{}` body is the fix (commit
    /// 87904ed8). A result of `no-body 400` + `{}-body 200` + `signed PUT 2xx`
    /// confirms the photo-upload bug AND its fix end-to-end, on-device.
    private func probeUploadMint(userId: String?, into lines: inout [String]) async {
        guard let userId else { lines.append("skipped: no user id"); return }
        guard let token = await SupabaseShared.currentAccessToken() else {
            lines.append("no access token (currentAccessToken returned nil)")
            return
        }
        let path = "\(userId.lowercased())/diagnostics/mint-probe.jpg"
        guard let mintURL = StorageURL.uploadSign(
            base: AppConfig.supabaseURL, bucket: PhotoStorageBucket.publicBucket, path: path
        ) else { lines.append("bad mint url"); return }

        // Mints once for the given body. Returns the log line to print plus the
        // response bytes on success (for the follow-up PUT). Returns a value
        // rather than appending to `lines` directly so the nested helper never
        // captures the `inout` parameter across an `await`.
        func mint(body: Data?, label: String) async -> (log: String, ok: Data?) {
            var request = URLRequest(url: mintURL)
            request.httpMethod = "POST"
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("true", forHTTPHeaderField: "x-upsert")
            request.httpBody = body
            do {
                let (data, response) = try await EdgeNetwork.shared.data(for: request)
                let code = (response as? HTTPURLResponse)?.statusCode ?? -1
                let b = String(data: data, encoding: .utf8)?.prefix(160) ?? ""
                return (
                    "mint \(label) HTTP \(code): \(b.isEmpty ? "(ok)" : String(b))",
                    (200..<300).contains(code) ? data : nil
                )
            } catch {
                return ("mint \(label) ERROR: \(error.localizedDescription)", nil)
            }
        }

        // Shipped build sent no body → expect 400. The fix sends `{}` → expect
        // 200 with a signed upload URL in the body.
        let noBody = await mint(body: nil, label: "no-body (shipped)")
        lines.append(noBody.log)
        let withBody = await mint(body: Data("{}".utf8), label: "{}-body (fix)")
        lines.append(withBody.log)
        guard let okData = withBody.ok else { return }

        // Complete the path: PUT the bytes to the minted URL, exactly as the
        // background uploader does — so a mint that succeeds but a PUT that fails
        // is still visible here.
        struct MintResponse: Decodable { let url: String }
        guard let decoded = try? JSONDecoder().decode(MintResponse.self, from: okData),
              let putURL = SignedUploadURLProvider.resolve(
                  base: AppConfig.supabaseURL, signedURL: decoded.url
              ) else {
            lines.append("signed PUT skipped: couldn't parse mint url")
            return
        }
        let put = PhotoUploadService.backgroundUploadRequest(signedURL: putURL)
        do {
            let (data, response) = try await EdgeNetwork.shared.upload(for: put, from: Self.probeJPEG)
            let code = (response as? HTTPURLResponse)?.statusCode ?? -1
            let b = String(data: data, encoding: .utf8)?.prefix(160) ?? ""
            lines.append("signed PUT HTTP \(code): \(b.isEmpty ? "(ok)" : String(b))")
        } catch {
            lines.append("signed PUT ERROR: \(error.localizedDescription)")
        }
    }

    /// Probes the REAL `item_photos` INSERT — the authenticated, RLS-subject
    /// upsert the photo pipeline runs after a successful PUT (the step the
    /// mint+PUT probe does NOT cover, and the step the SQL showed failing). Tied
    /// to the user's latest inventory item for the FK; reports success or the
    /// EXACT error, then deletes the diagnostic row.
    private func probeItemPhotoLink(userId: String?, into lines: inout [String]) async {
        guard let userId else { lines.append("skipped: no user id"); return }
        let itemId: String
        do {
            let resp = try await SupabaseShared.client
                .from("inventory_items")
                .select("id")
                .order("created_at", ascending: false)
                .limit(1)
                .execute()
            struct Row: Decodable { let id: String }
            guard let first = (try? JSONDecoder().decode([Row].self, from: resp.data))?.first else {
                lines.append("skipped: no inventory item to attach to")
                return
            }
            itemId = first.id
        } catch {
            lines.append("couldn't fetch an item: \(error.localizedDescription)")
            return
        }

        struct DiagPhotoRow: Encodable {
            let id: String
            let inventory_item_id: String
            let photo_type: String
            let storage_path: String
            let photo_url: String
            let sort_order: Int
            let bytes: Int
        }
        let rowId = "00000000-0000-4000-8000-0000000d1a90"
        let row = DiagPhotoRow(
            id: rowId,
            inventory_item_id: itemId,
            photo_type: "detail",
            storage_path: "\(userId.lowercased())/diagnostics/mint-probe.jpg",
            photo_url: "",
            sort_order: 999,
            bytes: 1
        )
        do {
            try await SupabaseShared.client.from("item_photos").upsert(row).execute()
            lines.append("item_photos INSERT: OK (authenticated upsert succeeded for item \(itemId.prefix(8))…)")
        } catch {
            lines.append("item_photos INSERT FAILED: \(error.localizedDescription)")
        }
        // Best-effort cleanup of the diagnostic row.
        _ = try? await SupabaseShared.client.from("item_photos").delete().eq("id", value: rowId).execute()
    }
}
