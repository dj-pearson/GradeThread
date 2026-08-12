package com.gradethread.app.platform.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * US-2496: a per-user response may not be cached under an account-blind key.
 *
 * The defect this guards was not "someone wrote a bad key". It was that
 * `EdgeApi.getRaw` accepted a `cacheTtlMillis`, a caller passed one for
 * `GET /api/flipdesk/photo-profiles` (which the edge answers per
 * `workspaceOwnerId ?? userId`), and nothing in between knew the response had an
 * owner. `TtlCache.clear()` existed the whole time with zero callers.
 *
 * So this file guards the CLASS, not the instance. A test asserting "the key
 * contains the owner" passes forever while a new caller adds a second,
 * account-blind cache one layer up. The three rules here are:
 *
 *  1. every API that ACCEPTS a cache TTL is known to this file - a new caching
 *     layer cannot appear without someone reading this;
 *  2. each of those APIs keys by the tenant, and refuses to cache without one;
 *  3. no cache-clearing method has zero production callers, which is the exact
 *     shape that made the original miss invisible.
 *
 * ! It scans the SWIFT tree too. iOS has no lane that runs on a Windows
 * checkout, and the Python guards under `ios/Scripts/` are enumerated one by one
 * in `ios-ci.yml`, so a new one there would need a workflow change to run at
 * all. This test runs in `testDebugUnitTest`, which Android CI gates on, and the
 * repo is fully checked out there - so it is the one place a cross-client rule
 * can actually be enforced today.
 */
class ResponseCacheTenantGuardTest {

    // -- Sources --------------------------------------------------------------

    /** A production source file, comments stripped. */
    private class Source(val path: String, val text: String)

    /**
     * Comments go FIRST. Every rule below is satisfiable by prose otherwise -
     * a header explaining that the key is tenant-scoped would pass a scan for
     * the word "owner" long after the code stopped doing it.
     */
    private fun strip(raw: String): String = raw
        .replace(Regex("""/\*[\s\S]*?\*/"""), "")
        .replace(Regex("""(?m)^\s*//.*$"""), "")
        .replace(Regex("""(?m)^\s*///.*$"""), "")

    private fun sources(root: String, extension: String): List<Source> {
        val dir = File(root)
        assertTrue(
            "Source root $root is missing - the tree moved and this guard is " +
                "scanning nothing. Re-anchor it rather than deleting it.",
            dir.isDirectory,
        )
        return dir.walkTopDown()
            .filter { it.isFile && it.extension == extension }
            .map { Source(it.path.replace('\\', '/'), strip(it.readText())) }
            .toList()
    }

    private val kotlinSources by lazy { sources("src/main/java", "kt") }
    private val swiftSources by lazy { sources("../../ios/GradeThread", "swift") }
    private val productionSources by lazy { kotlinSources + swiftSources }

    private fun source(nameEndsWith: String): Source =
        productionSources.first { it.path.endsWith(nameEndsWith) }

    /** The body from [from] up to the next declaration at the same-ish level. */
    private fun bodyOf(source: Source, from: String, until: String): String {
        val start = source.text.indexOf(from)
        assertTrue("`$from` is gone or was renamed in ${source.path}", start > -1)
        val end = source.text.indexOf(until, start)
        assertTrue("`$until` is gone or was renamed in ${source.path}", end > start)
        return source.text.substring(start, end)
    }

    // -- Rule 1: no unknown cache-admitting API -------------------------------

    /**
     * A parameter that turns caching ON, e.g. `cacheTtlMillis: Long` /
     * `cacheTTL: TimeInterval`. The property form (`let cacheTTL: TimeInterval =
     * 300`, a caller's own constant) is excluded - it admits nothing.
     */
    private val ttlParameter = Regex("""(cacheTtlMillis\s*:\s*Long|cacheTTL\s*:\s*TimeInterval)""")
    // `<reified T>` sits BEFORE the name in Kotlin and after it in Swift, so the
    // optional type-parameter list has to be skipped or `getJson` reads as the
    // function above it - which silently collapsed it into a duplicate entry.
    private val declaration = Regex("""(?:fun|func)\s+(?:<[^>]*>\s*)?(\w+)""")

    private fun cacheAdmittingApis(): List<String> {
        val found = mutableListOf<String>()
        for (source in productionSources) {
            for (match in ttlParameter.findAll(source.text)) {
                val before = source.text.substring(maxOf(0, match.range.first - 14), match.range.first)
                // A stored constant, not a parameter.
                if (Regex("""\b(val|var|let)\s+$""").containsMatchIn(before)) continue
                val name = declaration.findAll(source.text.substring(0, match.range.first))
                    .lastOrNull()?.groupValues?.get(1)
                    ?: "<unknown>"
                found += "${source.path.substringAfterLast('/')}::$name"
            }
        }
        return found.distinct().sorted()
    }

    @Test
    fun `every api that admits a cache ttl is accounted for`() {
        // Each of these keys its cache by the tenant - asserted below. A NEW
        // entry appearing here means a second caching layer was introduced, and
        // the question that has to be answered before adding it to this list is
        // "whose response is this, and is the owner in the key?".
        val known = listOf(
            "EdgeAPI.swift::getJSON",
            "EdgeAPI.swift::perform",
            "EdgeAPI.swift::performRaw",
            "EdgeApi.kt::getJson",
            "EdgeApi.kt::getRaw",
        )
        assertEquals(
            "A function now takes a cache TTL that this guard has never seen. " +
                "That is how US-2496 happened: a per-user endpoint was opted " +
                "into a cache whose key had no account in it. Key the new cache " +
                "by `workspaceOwner ?? signedInUser`, prove it with a test, and " +
                "then add it here.",
            known,
            cacheAdmittingApis(),
        )
    }

    // -- Rule 2: the key carries the owner ------------------------------------

    @Test
    fun `the android cache key carries the tenant, and no tenant means no cache`() {
        val edgeApi = source("platform/net/EdgeApi.kt")
        val getRaw = bodyOf(edgeApi, "suspend fun getRaw(", "suspend inline fun <reified T> getJson")

        assertTrue(
            "getRaw no longer resolves the cache owner. Without it the key is " +
                "account-blind and the next seller on this phone reads the " +
                "previous one's response.",
            getRaw.contains("cacheOwnerProvider()"),
        )
        assertTrue(
            "getRaw must build the key FROM the owner (cacheOwnerProvider() to " +
                "cacheKey), not merely mention it.",
            Regex("""cacheOwnerProvider\(\)[\s\S]{0,80}cacheKey\(""").containsMatchIn(getRaw),
        )
        assertTrue(
            "A null owner must mean NO caching - neither a read nor a write. A " +
                "placeholder tenant is a shared bucket wearing a name.",
            getRaw.contains("if (key != null) cache.get(key)") &&
                getRaw.contains("if (key != null) cache.put(key,"),
        )
        assertTrue(
            "cacheKey must TAKE the owner. A key function that can be called " +
                "without one will be, eventually.",
            edgeApi.text.contains("fun cacheKey(owner: String,"),
        )
    }

    @Test
    fun `the ios cache key carries the tenant, and no tenant means no cache`() {
        val edgeAPI = source("Networking/EdgeAPI.swift")
        val performRaw = bodyOf(
            edgeAPI,
            "private func performRaw(",
            "static func isTransient(",
        )

        assertTrue(
            "performRaw no longer resolves the cache tenant.",
            performRaw.contains("cacheTenantProvider()"),
        )
        assertTrue(
            "The tenant must be IN the key string, not just resolved beside it.",
            Regex("""cacheKey\s*=\s*cacheTenant\.map\s*\{""").containsMatchIn(performRaw),
        )
        assertTrue(
            "An unresolvable tenant must disable the cache. `?? \"personal\"` is " +
                "what let two accounts on one device share a key before US-2496.",
            performRaw.contains("if let cacheKey, method == \"GET\", let cached = cacheLookup(cacheKey)") &&
                performRaw.contains("if let cacheKey, method == \"GET\" {"),
        )
        assertTrue(
            "The tenant must be the workspace owner ELSE the signed-in user. The " +
                "workspace owner alone is nil in a personal workspace, which is " +
                "the account-blind case.",
            source("Networking/SupabaseShared.swift").text.contains(
                "if let owner = WorkspaceScope.activeOwnerId { return owner }",
            ),
        )
    }

    // -- Rule 3: no cache clear with zero callers -----------------------------

    /** A non-private declaration, its owning type, and where it sits. */
    private class Declared(
        val source: Source,
        val name: String,
        val type: String,
        val at: Int,
    )

    private val memberDeclaration =
        Regex("""(?m)^[ \t]*((?:@\w+[ \t]+)*(?:public |internal |open |override |final |static |class |suspend )*)(?:fun|func)\s+(\w+)""")
    private val typeDeclaration = Regex("""(?m)^[ \t]*(?:\w+[ \t]+)*(class|object|interface|actor|struct|enum)\s+(\w+)""")

    /**
     * Declarations that DROP a cache: named clear/purge/invalidate, on a type
     * whose name says cache (or with "Cache" in the method name). Private ones
     * are skipped - their callers can only be in the same file, so "has a
     * caller elsewhere" is the wrong question for them.
     */
    private fun cacheClearingDeclarations(): List<Declared> =
        productionSources.flatMap { source ->
            memberDeclaration.findAll(source.text).mapNotNull { match ->
                val line = match.value
                if (line.contains("private") || line.contains("fileprivate")) return@mapNotNull null
                val name = match.groupValues[2]
                if (!Regex("""^(clear|purge|invalidate)\w*$""").matches(name)) return@mapNotNull null
                val enclosingType = typeDeclaration
                    .findAll(source.text.substring(0, match.range.first))
                    .lastOrNull()?.groupValues?.get(2).orEmpty()
                val aboutACache = name.contains("Cache") || enclosingType.contains("Cache")
                if (!aboutACache) return@mapNotNull null
                Declared(source, name, enclosingType, match.range.first)
            }
        }

    /**
     * Bare verbs. `clear` is the most-called method name in the app - Room
     * DAOs, preference stores, filter state - so a cross-file `.clear()` proves
     * nothing on its own and has to be matched against the RECEIVER. A named
     * method (`clearCache`, `clearAllResponseCaches`, `signOutClearance`) is
     * specific enough to count wherever it appears in the same language.
     *
     * This was found by sabotage, not by reading: with a plain substring match,
     * deleting BOTH new clearances from the sign-out path still passed, because
     * `pushRegistration.clear()` two lines below satisfied the search.
     */
    private val bareVerbs = setOf("clear", "clearAll", "purge", "invalidate")

    /** Does [file] call [name] in a way that plausibly means [type]'s copy? */
    private fun callsIt(file: Source, name: String, type: String): Boolean =
        Regex("""(\w+)\s*\.\s*$name\s*\(""").findAll(file.text).any { call ->
            val receiver = call.groupValues[1]
            !bareVerbs.contains(name) || receiver.equals(type, ignoreCase = true)
        }

    /**
     * Names that count as "this clear is reachable": the method itself, plus any
     * same-file member that calls it. One hop, because the wiring shape this
     * repo uses is a `signOutClearance()` wrapper handed to a hook list - the
     * exit path never names `clearCache` itself.
     */
    private fun reachableNames(declared: Declared): Set<String> {
        val members = memberDeclaration.findAll(declared.source.text).toList()
        val names = mutableSetOf(declared.name)
        members.forEachIndexed { index, match ->
            val end = members.getOrNull(index + 1)?.range?.first ?: declared.source.text.length
            val body = declared.source.text.substring(match.range.first, end)
            if (body.contains("${declared.name}()")) names += match.groupValues[2]
        }
        return names
    }

    @Test
    fun `every cache clear has a production caller`() {
        val declarations = cacheClearingDeclarations()
        assertTrue(
            "No cache-clearing methods found at all - the discovery regex has " +
                "stopped matching and this rule is silently green.",
            declarations.size >= 4,
        )

        val orphans = declarations.filter { declared ->
            val names = reachableNames(declared)
            productionSources.none { other ->
                // Same language only: `EdgeAPI.shared.clearCache()` in the Swift
                // tree must not count as wiring for a Kotlin method that happens
                // to share a name.
                other.path.substringAfterLast('.') ==
                    declared.source.path.substringAfterLast('.') &&
                    other.path != declared.source.path &&
                    names.any { callsIt(other, it, declared.type) }
            }
        }

        assertTrue(
            "These cache-clearing methods have no caller outside their own file:\n" +
                orphans.joinToString("\n") { "  ${it.source.path}: ${it.name}" } +
                "\n\nThat is the shape US-2496 was found in: TtlCache.clear() " +
                "existed, was correct, and was called by nobody, so a cache that " +
                "outlived a sign-out looked handled. Wire it to the sign-out / " +
                "workspace-switch path, or delete it - do not leave it looking " +
                "like protection.",
            orphans.isEmpty(),
        )
    }
}
