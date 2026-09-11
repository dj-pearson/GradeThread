#!/usr/bin/env python3
"""US-2688: every key the iPhone sends must be a key the route reads.

THE OUTAGE THIS EXISTS TO CATCH. `DisputeSheet.submit()` declared its request
struct inline with a plain `gradeReportId`. Every EdgeAPI request is encoded by
`JSONEncoder.iso8601`, which sets `.convertToSnakeCase`, so the phone sent
`grade_report_id`. `routes/grade.ts` read `body.gradeReportId` with no
snake_case fallback, answered 400, and the sheet rendered the server's own
string - so the customer was shown a property name. Every grade dispute filed
from an iPhone failed for two days and nothing anywhere said so.

WHY A ONE-OFF FIX IS NOT ENOUGH. The encoder rewrites EVERY multi-word key on
EVERY request the app sends through EdgeAPI. The same mismatch is one inline
struct away in any of the sixty-odd other call sites, and it is invisible in
review because Swift and TypeScript agree on the spelling while the wire does
not.

WHAT THIS CHECKS. For each iOS call that goes through the SHARED encoder, work
out the bytes it really sends, find the Hono handler at that path, and fail if
the handler reads the camelCase spelling and never the snake_case one.

TRANSPORT, NOT STRUCT, DECIDES. This is the trap the first sweep of US-2688
fell into and reported three broken routes that were fine. Twenty-six files
build their own plain `JSONEncoder()`, which does NOT transform keys, so their
camelCase properties reach the route as camelCase and a route reading camelCase
is correct. `EbayPublishService` is the live example: four call sites, its own
private `postJSON`, its own `JSONEncoder()`. Only calls on an `EdgeAPI`
receiver - plus explicit `JSONEncoder.iso8601.encode` - count here.

Run: python ios/Scripts/check-request-key-casing.py [--verbose]
"""

from __future__ import annotations

import os
import re
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
IOS_DIR = os.path.join(REPO, "ios", "GradeThread")
ROUTES_DIR = os.path.join(REPO, "services", "edge-functions", "src", "routes")
MAIN_TS = os.path.join(REPO, "services", "edge-functions", "src", "main.ts")

# Corpus floors. A scan that matches nothing reports a confident zero, which is
# indistinguishable from a clean tree - so refuse to report at all when the
# corpus has collapsed. Each number is the measured count on 2026-09-11 with
# room to shrink for ordinary deletions.
MIN_CALL_SITES = 45
MIN_EDGE_HANDLERS = 400
MIN_MULTIWORD_SITES = 25
MIN_PAIRED_SITES = 40
# Median characters per handler slice. A truncated slice contains no body read,
# so every comparison against it is vacuously clean; measured median is ~1100.
MIN_MEDIAN_HANDLER_CHARS = 400

# Keys the phone sends that nothing on the edge reads, each with the reason it
# is allowed. Baseline measured 2026-09-11 is EMPTY and the check fails at zero,
# which is the only threshold that stays honest. A stale entry is reported too,
# so the list can only shrink. Key format: "<route path>::<wire key>".
ALLOWED_UNREAD: dict[str, str] = {}


# ---------------------------------------------------------------- key casing
def to_snake(key: str) -> str:
    """Port of Swift's JSONEncoder.KeyEncodingStrategy.convertToSnakeCase.

    Written out rather than approximated with a regex because the acronym rule
    is where a guess goes wrong: `dataURL` becomes `data_url`, not `data_u_r_l`,
    and a wrong answer here invents mismatches that do not exist.
    """
    if not key:
        return key
    lead = 0
    while lead < len(key) and key[lead] == "_":
        lead += 1
    if lead == len(key):
        return key
    trail = len(key)
    while trail > lead and key[trail - 1] == "_":
        trail -= 1
    core = key[lead:trail]
    words: list[str] = []
    start = 0
    i = 0
    n = len(core)
    while i < n:
        if core[i].isupper():
            j = i
            while j < n and core[j].isupper():
                j += 1
            if j - i > 1 and j < n:
                # An uppercase run followed by lowercase: the last capital opens
                # the next word (URLSession -> url_session).
                j -= 1
            if i > start:
                words.append(core[start:i])
            start = i
            i = j if j > i else i + 1
        else:
            i += 1
    words.append(core[start:])
    return key[:lead] + "_".join(w.lower() for w in words if w) + key[trail:]


# --------------------------------------------------------------- text slicing
def balanced(src: str, open_idx: int, opener: str = "(", closer: str = ")"):
    """Text between the bracket at open_idx and its match, string-literal aware."""
    depth = 0
    i = open_idx
    in_str = False
    while i < len(src):
        ch = src[i]
        if in_str:
            if ch == "\\":
                i += 2
                continue
            if ch == '"':
                in_str = False
        else:
            if ch == '"':
                in_str = True
            elif ch in "([{":
                depth += 1
            elif ch in ")]}":
                depth -= 1
                if depth == 0:
                    return src[open_idx + 1 : i]
        i += 1
    return None


def split_args(text: str) -> list[str]:
    parts: list[str] = []
    depth = 0
    in_str = False
    cur: list[str] = []
    i = 0
    while i < len(text):
        ch = text[i]
        if in_str:
            cur.append(ch)
            if ch == "\\":
                cur.append(text[i + 1] if i + 1 < len(text) else "")
                i += 2
                continue
            if ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
            cur.append(ch)
        elif ch in "([{":
            depth += 1
            cur.append(ch)
        elif ch in ")]}":
            depth -= 1
            cur.append(ch)
        elif ch == "," and depth == 0:
            parts.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
        i += 1
    if "".join(cur).strip():
        parts.append("".join(cur).strip())
    return parts


def strip_ts_comments(src: str) -> str:
    """Drop comments so an explanation cannot stand in for the code.

    Not a formality here. `grade.ts` carries a long comment block ABOUT this
    bug that names both spellings several times; a scan reading the raw file
    would call the route fixed with the whole read deleted.
    """
    src = re.sub(r"/\*[\s\S]*?\*/", "", src)
    return "\n".join(l for l in src.split("\n") if not re.match(r"^\s*(//|\*)", l))


# ------------------------------------------------------------- swift: structs
STRUCT_RE = re.compile(
    r"\b(?:private\s+|fileprivate\s+|public\s+|internal\s+)?struct\s+(\w+)\s*(?::[^{\n]*)?\{"
)
PROP_RE = re.compile(r"^\s*(?:public\s+|private\s+|internal\s+)?(?:let|var)\s+(\w+)\s*[:=]", re.M)
CODINGKEY_RE = re.compile(r"case\s+(\w+)\s*=\s*\"([^\"]+)\"")


def struct_index(sources: dict[str, str]) -> dict[str, list[dict]]:
    """name -> [{file, at, body}], every declaration including function-local ones."""
    index: dict[str, list[dict]] = {}
    for rel, src in sources.items():
        for m in STRUCT_RE.finditer(src):
            body = balanced(src, m.end() - 1, "{", "}")
            if body is None:
                continue
            index.setdefault(m.group(1), []).append({"file": rel, "at": m.start(), "body": body})
    return index


def top_level(body: str) -> str:
    """Blank out anything nested one brace deeper, so a nested type's properties
    and a computed property's getter cannot be read as stored properties."""
    out: list[str] = []
    depth = 0
    in_str = False
    i = 0
    while i < len(body):
        ch = body[i]
        if in_str:
            if ch == "\\":
                i += 2
                continue
            if ch == '"':
                in_str = False
            out.append(ch)
        elif ch == '"':
            in_str = True
            out.append(ch)
        elif ch == "{":
            depth += 1
            out.append(" ")
        elif ch == "}":
            depth -= 1
            out.append(" ")
        else:
            out.append(ch if depth == 0 else ("\n" if ch == "\n" else " "))
        i += 1
    return "".join(out)


def struct_keys(decl: dict) -> list[tuple[str, str]]:
    """[(swift property, wire key)] for one struct declaration."""
    body = decl["body"]
    props = PROP_RE.findall(top_level(body))
    aliases: dict[str, str] = {}
    ck = re.search(r"enum\s+CodingKeys\b[^{]*\{", body)
    if ck:
        ckbody = balanced(body, ck.end() - 1, "{", "}")
        if ckbody:
            aliases = dict(CODINGKEY_RE.findall(ckbody))
    # An alias does NOT protect a key: Swift applies the strategy to the
    # CodingKey's stringValue, so `case gradeReportId = "gradeReportId"` still
    # leaves as grade_report_id. That is the whole reason this fix is
    # server-side, and getting it wrong here would hide the bug it was written
    # for. The alias only changes WHICH string the strategy is applied to.
    return [(p, to_snake(aliases.get(p, p))) for p in props]


BUILTIN_TYPES = {
    "String", "Int", "Double", "Bool", "Data", "Date", "URL", "UUID", "Decimal", "Float",
}


def resolve_struct(name: str, file: str, at: int, index: dict[str, list[dict]]):
    """The declaration this call site means.

    Scoped to the declaring FILE first, because `Body` is declared inside a
    dozen different functions across the app. A global lookup merges all of them
    and invents keys nobody sends - the first run of this scan reported exactly
    that and named a route that was fine.
    """
    decls = index.get(name)
    if not decls:
        return None
    same = [d for d in decls if d["file"] == file]
    if same:
        before = [d for d in same if d["at"] < at]
        return max(before, key=lambda d: d["at"]) if before else same[0]
    return decls[0] if len(decls) == 1 else None


def wire_keys(name: str, file: str, at: int, index, depth: int = 0, seen=None):
    """Keys for a body type and the custom types nested inside it."""
    if seen is None:
        seen = set()
    if depth > 3 or name in seen or name in BUILTIN_TYPES:
        return []
    decl = resolve_struct(name, file, at, index)
    if decl is None:
        return []
    seen.add(name)
    out = list(struct_keys(decl))
    for m in re.finditer(r"(?:let|var)\s+\w+\s*:\s*\[?([A-Z]\w*)", top_level(decl["body"])):
        out.extend(wire_keys(m.group(1), decl["file"], decl["at"], index, depth + 1, seen))
    return out


# --------------------------------------------------------- swift: call sites
# Only a call on an EdgeAPI receiver. `EbayPublishService` has its own private
# `postJSON` on a plain JSONEncoder, so a bare `postJSON(` must NOT match.
SHARED_CALL_RE = re.compile(r"\b(\w+(?:\.\w+)*)\.(postJSON|putJSON|patchJSON)\s*\(")
RAW_ENCODE_RE = re.compile(r"JSONEncoder\.iso8601\.encode\(\s*([A-Z]\w*)\s*\(")
EDGE_RECEIVERS = ("EdgeAPI.shared", "EdgeAPI")


def edge_receiver(receiver: str, src: str) -> bool:
    if receiver in EDGE_RECEIVERS or receiver.endswith(".shared") and receiver.startswith("EdgeAPI"):
        return True
    leaf = receiver.split(".")[-1]
    if re.search(r"\b(?:let|var)\s+" + re.escape(leaf) + r"\s*:\s*EdgeAPI\b", src):
        return True
    return bool(re.search(r"\b" + re.escape(leaf) + r"\s*:\s*EdgeAPI\b", src))


def path_constants(src: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for m in re.finditer(r'static\s+(?:let|var)\s+(\w+)\s*(?::\s*String\s*)?=\s*"([^"]*)"', src):
        out[m.group(1)] = m.group(2)
    for m in re.finditer(r'(?:static\s+)?(?:let|var)\s+(\w+)\s*(?::\s*String\s*)?=\s*"([^"]*)"', src):
        out.setdefault(m.group(1), m.group(2))
    for m in re.finditer(r'func\s+(\w+)\([^)]*\)\s*->\s*String\s*\{\s*"([^"]*)"', src):
        out.setdefault("()" + m.group(1), m.group(2))
    return out


def resolve_path(expr: str, consts: dict[str, str], depth: int = 0) -> str:
    expr = expr.strip()
    if expr.startswith("path:"):
        expr = expr[len("path:") :].strip()
    if depth > 6:
        return "*"
    lit = re.fullmatch(r'"([^"]*)"', expr)
    if lit:
        return re.sub(
            r"\\\(([^()]*(?:\([^()]*\))?[^()]*)\)",
            lambda mm: resolve_path(mm.group(1), consts, depth + 1),
            lit.group(1),
        )
    ident = re.fullmatch(r"(?:Self\.|Path\.)?(\w+)", expr)
    if ident and ident.group(1) in consts:
        return resolve_path('"' + consts[ident.group(1)] + '"', consts, depth + 1)
    call = re.fullmatch(r"(?:Self\.|Path\.)?(\w+)\s*\(.*\)", expr, re.S)
    if call and ("()" + call.group(1)) in consts:
        return resolve_path('"' + consts["()" + call.group(1)] + '"', consts, depth + 1)
    return "*"


def resolve_body_type(expr: str, src: str, at: int) -> str | None:
    expr = (expr or "").strip()
    ctor = re.match(r"^([A-Z]\w*)\s*\(", expr)
    if ctor:
        return ctor.group(1)
    if re.fullmatch(r"\w+", expr):
        head = src[:at]
        for pat in (
            r"\b(?:let|var)\s+" + re.escape(expr) + r"\s*(?::\s*[A-Z]\w*)?\s*=\s*([A-Z]\w*)\s*\(",
            r"\b(?:let|var)\s+" + re.escape(expr) + r"\s*:\s*([A-Z]\w*)",
            r"\b" + re.escape(expr) + r"\s*:\s*([A-Z]\w*)[,)\s]",
        ):
            found = list(re.finditer(pat, head))
            if found:
                return found[-1].group(1)
    return None


def collect_sites(sources: dict[str, str]) -> list[dict]:
    sites: list[dict] = []
    for rel, src in sorted(sources.items()):
        if rel.endswith("Networking/EdgeAPI.swift"):
            continue
        consts = path_constants(src)
        for m in SHARED_CALL_RE.finditer(src):
            if not edge_receiver(m.group(1), src):
                continue
            inner = balanced(src, m.end() - 1)
            if inner is None:
                continue
            args = split_args(inner)
            body_expr = next((a[len("body:") :].strip() for a in args[1:] if a.startswith("body:")), "")
            sites.append(
                {
                    "file": rel,
                    "line": src.count("\n", 0, m.start()) + 1,
                    "path": resolve_path(args[0] if args else "", consts),
                    "type": resolve_body_type(body_expr, src, m.start()),
                    "at": m.start(),
                }
            )
        # The other shared-encoder transport: the caller encodes with
        # JSONEncoder.iso8601 itself and hands the bytes to sendRaw /
        # postForStatus. Same strategy, same hazard.
        for m in RAW_ENCODE_RE.finditer(src):
            tail = src[m.end() : m.end() + 900]
            call = re.search(r"\.(?:postForStatus|sendRaw)\(\s*(?:[\w]+:\s*)?(\"[^\"]*\")", tail)
            if not call:
                continue
            sites.append(
                {
                    "file": rel,
                    "line": src.count("\n", 0, m.start()) + 1,
                    "path": resolve_path(call.group(1), consts),
                    "type": m.group(1),
                    "at": m.start(),
                }
            )
    return sites


# -------------------------------------------------------------- edge handlers
# WARNING: ANCHORED AT THE LINE START AND REQUIRING THE `...Routes` RECEIVER, BOTH OF
# WHICH ARE LOAD-BEARING. A loose `\w+\.(get|post|...)\(` ends the first handler's
# slice at its own `c.get("userId")` - line one of nearly every route in this
# service. The slice was then ~40 characters, every body read fell outside it,
# and the scan pronounced all 62 pairings clean while reporting that the dispute
# route reads NEITHER spelling of the key it demonstrably reads. A truncated
# slice is the quietest way for a pairing scan to be wrong.
REGISTRATION_RE = re.compile(
    r'^(?:export\s+)?\w*Routes\.(get|post|put|patch|delete|all|use)\(\s*(?:"([^"]*)")?',
    re.M,
)


def collect_handlers(main_src: str, route_sources: dict[str, str]) -> list[dict]:
    prefixes: dict[str, list[str]] = {}
    for pre, var in re.findall(r'app\.route\(\s*"([^"]+)"\s*,\s*(\w+)\s*\)', main_src):
        prefixes.setdefault(var, []).append(pre)
    file_of: dict[str, str] = {}
    for m in re.finditer(r'import\s*\{([^}]*)\}\s*from\s*"\./routes/([\w.-]+)\.ts"', main_src):
        for alias in (a.strip() for a in m.group(1).split(",")):
            if alias:
                file_of[alias] = m.group(2) + ".ts"

    handlers: list[dict] = []
    for var, pres in prefixes.items():
        rel = file_of.get(var)
        if rel is None or rel not in route_sources:
            continue
        src = route_sources[rel]
        regs = list(REGISTRATION_RE.finditer(src))
        # The registration's own extent, from its opening paren to the matching
        # close. Everything AFTER one handler ends and BEFORE the next begins is
        # that next handler's preamble - its body `interface`, its zod schema,
        # its local helper - and the keys it reads live there as often as in the
        # handler itself. Slicing registration-to-registration attaches the
        # preamble to the wrong handler, which is what made twelve correct
        # routes look like they read neither spelling.
        ends = []
        for m in regs:
            paren = src.find("(", m.start())
            inner = balanced(src, paren) if paren != -1 else None
            ends.append(paren + 1 + len(inner) if inner is not None else m.end())
        for i, m in enumerate(regs):
            if m.group(1) not in ("post", "put", "patch") or m.group(2) is None:
                continue
            start = ends[i - 1] if i > 0 else 0
            end = max(ends[i], m.end())
            for pre in pres:
                handlers.append(
                    {
                        "file": rel,
                        "path": (pre.rstrip("/") + "/" + m.group(2).lstrip("/")).rstrip("/"),
                        "src": strip_ts_comments(src[start:end]),
                        # The whole route file, for the "is this key read at
                        # all?" question only. Several handlers pass the body to
                        # a helper defined at the top of their own file.
                        "file_src": strip_ts_comments(src),
                    }
                )
    return handlers


# WARNING: THE READ MUST BE SCOPED TO THE BODY, NOT TO THE HANDLER TEXT.
#
# The first version of this guard asked "does the handler mention the string
# `grade_report_id` anywhere", and it was SILENT on the real sabotage: delete
# the snake_case branch from the dispute route and the handler still says
# `grade_report_id` twice, because that is also the COLUMN NAME - in
# `.eq("grade_report_id", ...)` and in the insert. In a snake_case database
# every wire key has a column with the same spelling sitting next to it, so a
# bare substring search can never distinguish a read from a write. The deno
# test caught the sabotage; this did not.
BODY_HOLDER = r"(?:body|payload|input|json|parsed)"
DESTRUCTURE_RE = re.compile(r"\{([^{}]*)\}\s*=\s*(?:await\s+)?\w+")


def reads_from_body(src: str, key: str) -> bool:
    """Strictly: the handler reads `key` off the request body itself."""
    k = re.escape(key)
    if re.search(r"\b" + BODY_HOLDER + r"\s*(?:\?\.|\.)\s*" + k + r"\b", src):
        return True
    if re.search(r"\b" + BODY_HOLDER + r"\s*(?:\?\.)?\[\s*[\"']" + k + r"[\"']\s*\]", src):
        return True
    return bool(re.search(r"\{[^{}]*\b" + k + r"\b[^{}]*\}\s*=\s*(?:await\s+)?" + BODY_HOLDER + r"\b", src))


def reads_anywhere(src: str, key: str) -> bool:
    """Charitably: the handler reads `key` off SOMETHING.

    Deliberately loose, and only ever used to decide that a key IS handled, so
    the looseness can only silence a report, never invent one. It covers the
    nested case the strict form cannot see: `Body { updates: [Update] }` reaches
    the route as `for (const u of body.updates) { u.listing_id }`, where the key
    is read off the element rather than off the body.

    A property ACCESS, not a mention. `.eq("grade_report_id", id)` is a string
    and `insert({ grade_report_id: id })` is an object key - both are the column
    of the same name, both sit inside the very handler whose body read was
    deleted, and a substring search calls that handler fixed.
    """
    k = re.escape(key)
    # A DOT followed by the key. `.eq("grade_report_id", id)` puts a quote
    # between the dot and the key, and `insert({ grade_report_id: id })` has no
    # dot at all, so neither form of the column name satisfies this.
    if re.search(r"\.\s*" + k + r"\b", src):
        return True
    for m in DESTRUCTURE_RE.finditer(src):
        if key in [n.split(":")[0].strip() for n in m.group(1).split(",")]:
            return True
    return False


def segments(p: str) -> list[str]:
    return [s for s in p.strip("/").split("/") if s]


def path_matches(ios_path: str, route_path: str) -> bool:
    a, b = segments(ios_path), segments(route_path)
    if len(a) != len(b):
        return False
    for x, y in zip(a, b):
        if x == "*" or y.startswith(":"):
            continue
        if x.lower() != y.lower():
            return False
    return True


# ----------------------------------------------------------------- the check
def analyze(
    sites: list[dict],
    index: dict[str, list[dict]],
    handlers: list[dict],
    elsewhere: str = "",
) -> dict:
    """`elsewhere` is the edge's shared lib text. Several routes hand the whole
    body to a normalizer (`normalizeRuleInput`, `decodeImageDataUrl`) that reads
    the keys a module away, so a key absent from the handler is not necessarily
    a key nobody reads. It only affects the reported-not-failed list."""
    rows = []
    for site in sites:
        keys = wire_keys(site["type"], site["file"], site["at"], index) if site["type"] else []
        multi = sorted({(p, w) for (p, w) in keys if p != w})
        matched = [h for h in handlers if path_matches(site["path"], h["path"])]
        bad = []
        silent = []
        for prop, wire in multi:
            for h in matched:
                # Strict on the camelCase side, charitable on the snake_case
                # side: a report costs someone an investigation, so it is only
                # raised when the handler unmistakably reads the spelling the
                # phone cannot send and nothing at all reads the one it does.
                reads_wire = reads_anywhere(h["src"], wire)
                reads_prop = reads_from_body(h["src"], prop)
                if reads_prop and not reads_wire:
                    bad.append((prop, wire, h["file"], h["path"]))
                elif (
                    not reads_prop
                    and not reads_wire
                    and not reads_anywhere(h.get("file_src", ""), wire)
                    and not reads_anywhere(elsewhere, wire)
                ):
                    # The phone sends this key and NOTHING reads it - not the
                    # handler, not the rest of its route file, not the shared
                    # libs. Usually a Swift-side rename that nobody carried
                    # across, which is the same outage as a casing mismatch with
                    # none of the tells: the request succeeds, the field is
                    # dropped, and the seller's value is simply gone.
                    silent.append((prop, wire, h["file"], h["path"]))
        rows.append({"site": site, "multi": multi, "matched": matched, "bad": bad, "silent": silent})
    return {
        "rows": rows,
        "mismatches": [r for r in rows if r["bad"]],
        "paired": [r for r in rows if r["matched"]],
        "multiword": [r for r in rows if r["multi"]],
        "silent": [r for r in rows if r["silent"]],
    }


# ------------------------------------------------------------------ fixtures
# The guard is run against these before it is run against the repo. A pairing
# scan that matches nothing reports a confident zero, and there is no way to
# tell that apart from a clean tree by looking at the output - so make it prove
# it can still see a break first.
FIXTURE_SWIFT = {
    "Fixture/BadService.swift": """
struct BadService {
    private let api: EdgeAPI
    struct BadBody: Encodable { let widgetId: String }
    func send(_ id: String) async throws {
        let _: OK = try await api.postJSON("/api/fixture/bad", body: BadBody(widgetId: id))
    }
}
""",
    "Fixture/GoodService.swift": """
struct GoodService {
    private let api: EdgeAPI
    struct GoodBody: Encodable { let itemId: String }
    func send(_ id: String) async throws {
        let _: OK = try await api.postJSON("/api/fixture/good", body: GoodBody(itemId: id))
    }
}
""",
    "Fixture/BothService.swift": """
struct BothService {
    private let api: EdgeAPI
    struct BothBody: Encodable { let orderId: String }
    func send(_ id: String) async throws {
        let _: OK = try await api.postJSON("/api/fixture/both", body: BothBody(orderId: id))
    }
}
""",
    "Fixture/CommentService.swift": """
struct CommentService {
    private let api: EdgeAPI
    struct CommentBody: Encodable { let saleId: String }
    func send(_ id: String) async throws {
        let _: OK = try await api.postJSON("/api/fixture/comment", body: CommentBody(saleId: id))
    }
}
""",
    # The sabotage this guard FAILED the first time it was run against one. The
    # route reads body.invoiceId, which the phone cannot send - and the same
    # handler says `invoice_id` twice, because that is the column name. A
    # substring search calls this fixed.
    "Fixture/ColumnService.swift": """
struct ColumnService {
    private let api: EdgeAPI
    struct ColumnBody: Encodable { let invoiceId: String }
    func send(_ id: String) async throws {
        let _: OK = try await api.postJSON("/api/fixture/column", body: ColumnBody(invoiceId: id))
    }
}
""",
    # The other direction: a key nested inside an array element, read off the
    # element rather than off the body. Correct, and must not be reported.
    "Fixture/NestedService.swift": """
struct NestedService {
    private let api: EdgeAPI
    struct NestedLine: Encodable { let lineId: String }
    struct NestedBody: Encodable { let updates: [NestedLine] }
    func send(_ id: String) async throws {
        let _: OK = try await api.postJSON("/api/fixture/nested", body: NestedBody(updates: [NestedLine(lineId: id)]))
    }
}
""",
    # A key renamed on the Swift side only. Nothing reads it; the request
    # succeeds and the value is dropped.
    "Fixture/DroppedService.swift": """
struct DroppedService {
    private let api: EdgeAPI
    struct DroppedBody: Encodable { let renamedFieldId: String }
    func send(_ id: String) async throws {
        let _: OK = try await api.postJSON("/api/fixture/dropped", body: DroppedBody(renamedFieldId: id))
    }
}
""",
    "Fixture/OwnEncoderService.swift": """
struct OwnEncoderService {
    struct OwnBody: Encodable { let batchId: String }
    func send(_ id: String) async throws {
        let _: OK = try await postJSON(path: "/api/fixture/own", body: OwnBody(batchId: id))
    }
    private func postJSON<R: Decodable, B: Encodable>(path: String, body: B) async throws -> R {
        _ = try JSONEncoder().encode(body)
        fatalError()
    }
}
""",
}

FIXTURE_MAIN = """
import { fixtureRoutes } from "./routes/fixture.ts";
app.route("/api/fixture", fixtureRoutes);
"""

FIXTURE_ROUTES = {
    # Every handler opens with `c.get("userId")`, exactly as the real ones do.
    # That line is what truncated every slice while the registration pattern was
    # loose, so the fixture now fails if that regression comes back.
    "fixture.ts": """
fixtureRoutes.post("/bad", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const body = await c.req.json();
  const widgetId = body.widgetId;
  return c.json({ ownerId, widgetId });
});
fixtureRoutes.post("/good", async (c) => {
  const ownerId = c.get("userId");
  const body = await c.req.json();
  return c.json({ ownerId, id: body.item_id });
});
fixtureRoutes.post("/both", async (c) => {
  const ownerId = c.get("userId");
  const body = await c.req.json();
  return c.json({ ownerId, id: body.orderId ?? body.order_id });
});
fixtureRoutes.post("/comment", async (c) => {
  const ownerId = c.get("userId");
  const body = await c.req.json();
  /* The phone sends body.sale_id, and the line below does not read it. This
     comment is the hazard: it contains the exact property access the scan
     looks for, so a scan that forgets to strip comments is satisfied by the
     explanation of the bug. routes/grade.ts carries a comment block of this
     shape, naming both spellings, directly above the code in question. */
  return c.json({ ownerId, id: body.saleId });
});
fixtureRoutes.post("/own", async (c) => {
  const ownerId = c.get("userId");
  const body = await c.req.json();
  return c.json({ ownerId, id: body.batchId });
});
fixtureRoutes.post("/column", async (c) => {
  const ownerId = c.get("userId");
  const body = await c.req.json();
  const invoiceId = body.invoiceId;
  const { data } = await db.from("invoices").select("id").eq("invoice_id", invoiceId);
  await db.from("audit").insert({ invoice_id: invoiceId, user_id: ownerId });
  return c.json({ data });
});
fixtureRoutes.post("/dropped", async (c) => {
  const ownerId = c.get("userId");
  const body = await c.req.json();
  return c.json({ ownerId, ok: typeof body === "object" });
});
fixtureRoutes.post("/nested", async (c) => {
  const ownerId = c.get("userId");
  const body = await c.req.json();
  const rows = Array.isArray(body.updates) ? body.updates : [];
  for (const u of rows) {
    if (typeof u.line_id === "string") await db.from("lines").update({}).eq("id", u.line_id);
  }
  return c.json({ ownerId, count: rows.length });
});
"""
}


def self_check() -> list[str]:
    """Fail the run if the scan can no longer see a break it is meant to see."""
    problems: list[str] = []
    if to_snake("gradeReportId") != "grade_report_id":
        problems.append("to_snake is wrong: gradeReportId -> " + to_snake("gradeReportId"))
    if to_snake("dataURL") != "data_url":
        problems.append("to_snake mangles acronyms: dataURL -> " + to_snake("dataURL"))
    if to_snake("reason") != "reason":
        problems.append("to_snake rewrites a single word: reason -> " + to_snake("reason"))

    index = struct_index(FIXTURE_SWIFT)
    sites = collect_sites(FIXTURE_SWIFT)
    handlers = collect_handlers(FIXTURE_MAIN, FIXTURE_ROUTES)
    report = analyze(sites, index, handlers)
    flagged = {(r["site"]["path"], r["bad"][0][0]) for r in report["mismatches"]}

    if ("/api/fixture/bad", "widgetId") not in flagged:
        problems.append("fixture: the camelCase-only route was NOT flagged")
    if ("/api/fixture/comment", "saleId") not in flagged:
        problems.append(
            "fixture: a handler whose COMMENT names the snake key passed - comment "
            "stripping has stopped working, which is how a deleted read reads as fixed"
        )
    if ("/api/fixture/column", "invoiceId") not in flagged:
        problems.append(
            "fixture: a handler that reads body.invoiceId and uses the COLUMN "
            "`invoice_id` beside it passed. In a snake_case database every wire key "
            "has a column of the same spelling next to it, so a substring search "
            "cannot tell a body read from a column name - and this guard silently "
            "passed the real sabotage the first time for exactly that reason"
        )
    for ok_path in ("/api/fixture/good", "/api/fixture/both", "/api/fixture/nested"):
        if any(p == ok_path for (p, _k) in flagged):
            problems.append("fixture: %s was flagged and it is correct" % ok_path)
    if any(p == "/api/fixture/own" for (p, _k) in flagged):
        problems.append(
            "fixture: a call on a PRIVATE postJSON with its own JSONEncoder was flagged. "
            "Transport decides, not the struct - this is the false positive the first "
            "sweep of US-2688 published"
        )
    dropped = {
        (r["site"]["path"], s[1]) for r in report["silent"] for s in r["silent"]
    }
    if ("/api/fixture/dropped", "renamed_field_id") not in dropped:
        problems.append(
            "fixture: a key NOTHING on the edge reads was not reported. A rename on "
            "the Swift side alone produces a 200 with the value silently dropped, "
            "which is the same outage with none of the tells"
        )
    for ok_path in ("/api/fixture/good", "/api/fixture/both", "/api/fixture/nested"):
        if any(p == ok_path for (p, _k) in dropped):
            problems.append("fixture: %s was reported as unread and it is read" % ok_path)
    if len(sites) != 7:
        problems.append(
            "fixture: expected 7 shared-encoder sites (the 8th uses its own encoder), got %d"
            % len(sites)
        )
    for h in handlers:
        if "c.req.json()" not in h["src"]:
            problems.append(
                "fixture: the handler slice for %s stops before its body read, so no "
                "assertion below it can see anything" % h["path"]
            )
    return problems


# ----------------------------------------------------------------------- main
def read(path: str) -> str:
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read()


def load_repo():
    swift: dict[str, str] = {}
    for dirpath, _dirs, files in os.walk(IOS_DIR):
        for fn in files:
            if fn.endswith(".swift"):
                full = os.path.join(dirpath, fn)
                swift[os.path.relpath(full, IOS_DIR).replace("\\", "/")] = read(full)
    routes: dict[str, str] = {}
    for fn in os.listdir(ROUTES_DIR):
        if fn.endswith(".ts"):
            routes[fn] = read(os.path.join(ROUTES_DIR, fn))
    libs = []
    lib_dir = os.path.join(os.path.dirname(ROUTES_DIR), "lib")
    if os.path.isdir(lib_dir):
        for fn in sorted(os.listdir(lib_dir)):
            if fn.endswith(".ts"):
                libs.append(strip_ts_comments(read(os.path.join(lib_dir, fn))))
    return swift, read(MAIN_TS), routes, "\n".join(libs)


def main(argv: list[str]) -> int:
    verbose = "--verbose" in argv

    problems = self_check()
    if problems:
        print("check-request-key-casing: THE GUARD ITSELF IS BROKEN")
        for p in problems:
            print("  -", p)
        print("\nIts fixture proves it can still see a mismatch. It cannot, so any")
        print("clean result it prints about the repo is meaningless.")
        return 1

    swift, main_src, routes, libs = load_repo()
    index = struct_index(swift)
    sites = collect_sites(swift)
    handlers = collect_handlers(main_src, routes)
    report = analyze(sites, index, handlers, elsewhere=libs)

    lengths = sorted(len(h["src"]) for h in handlers)
    median = lengths[len(lengths) // 2] if lengths else 0
    floors = [
        ("iOS shared-encoder call sites", len(sites), MIN_CALL_SITES),
        ("edge POST/PUT/PATCH handlers", len(handlers), MIN_EDGE_HANDLERS),
        ("call sites with a multi-word key", len(report["multiword"]), MIN_MULTIWORD_SITES),
        ("call sites paired to a handler", len(report["paired"]), MIN_PAIRED_SITES),
        ("median handler slice, chars", median, MIN_MEDIAN_HANDLER_CHARS),
    ]
    starved = [(what, got, floor) for (what, got, floor) in floors if got < floor]

    print(
        "check-request-key-casing: %d iOS sites through the shared encoder, "
        "%d edge handlers, %d sites paired, %d carrying a rewritten key"
        % (len(sites), len(handlers), len(report["paired"]), len(report["multiword"]))
    )

    if starved:
        print("\nTHE CORPUS COLLAPSED - not reporting a result:")
        for what, got, floor in starved:
            print("  - %s: %d, floor %d" % (what, got, floor))
        print(
            "\nA pairing scan that matches nothing prints the same zero as a clean\n"
            "tree. Either the code moved and the patterns need updating, or a large\n"
            "deletion is real and the floor should come down in the same commit."
        )
        return 1

    unpaired = [r for r in report["rows"] if not r["matched"]]
    if verbose:
        for r in report["rows"]:
            tag = "!!" if r["bad"] else ("??" if not r["matched"] else "ok")
            print(
                "  %s %s:%d  %s  <- %s  %s"
                % (
                    tag,
                    r["site"]["file"],
                    r["site"]["line"],
                    r["site"]["path"],
                    r["site"]["type"],
                    ",".join("%s->%s" % kv for kv in r["multi"]) or "-",
                )
            )
    if unpaired:
        print("\n%d call site(s) whose handler this scan could not find:" % len(unpaired))
        for r in unpaired:
            print(
                "  ?  %s:%d  %s"
                % (r["site"]["file"], r["site"]["line"], r["site"]["path"])
            )
        print("  (reported, not failed: a dynamic path segment is legitimate)")

    unread = []
    seen_allowed = set()
    for r in report["silent"]:
        for prop, wire, hfile, hpath in r["silent"]:
            token = "%s::%s" % (hpath, wire)
            if token in ALLOWED_UNREAD:
                seen_allowed.add(token)
                continue
            unread.append((r["site"], prop, wire, hfile, hpath))

    stale = [t for t in ALLOWED_UNREAD if t not in seen_allowed]
    if stale:
        print("\nALLOWED_UNREAD entries that no longer match anything:")
        for t in stale:
            print("  -", t)
        print("  Delete them. An allowlist that outlives its reason is how a real")
        print("  finding gets waved through next time.")

    if unread:
        print("\nDROPPED - the phone sends a key nothing on the edge reads:\n")
        for site, prop, wire, hfile, hpath in unread:
            print("  %s:%d sends `%s`" % (site["file"], site["line"], wire))
            print("     routes/%s  %s  reads neither `%s` nor `%s`" % (hfile, hpath, wire, prop))
        print(
            "\nThis is the same outage as a casing mismatch with none of the tells:\n"
            "the request succeeds, the field is dropped, and whatever the seller\n"
            "typed is simply gone. Usually a rename on one side only. Either read\n"
            "the key on the route or stop sending it."
        )

    if report["mismatches"]:
        print("\nMISMATCH - the phone sends a key the route never reads:\n")
        for r in report["mismatches"]:
            s = r["site"]
            for prop, wire, hfile, hpath in r["bad"]:
                print("  %s:%d sends `%s`" % (s["file"], s["line"], wire))
                print("     routes/%s  %s  reads `%s` only" % (hfile, hpath, prop))
        print(
            "\nEvery EdgeAPI request is encoded with .convertToSnakeCase, and no\n"
            "CodingKeys alias overrides it - Swift applies the strategy to the\n"
            "alias too. Fix it on the ROUTE: read `body.snake_case ?? body.camelCase`.\n"
            "Left alone, the call fails 100% of the time from the phone only, and\n"
            "the customer is shown the route's own property name."
        )
        return 1

    if unread or stale:
        return 1

    print("OK - every rewritten key reaches a route that reads it.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
