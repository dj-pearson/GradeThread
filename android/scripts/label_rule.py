"""The LABEL rule (US-2976 AC9): English a person reads, written like a constant.

WHY A SECOND RULE. `no-unlocalized-copy.py`'s `is_copy` is a SENTENCE detector:
at least twelve characters, a space, a leading capital, and two all-lowercase
words. Measured 2026-08-28 by feeding it the app's own strings: 5 of 5 sentences
caught, 3 of 41 UI labels. Title Case and single words are invisible to it by
construction, so "Home", "Inventory", "Marketplaces", the five grading-factor
names and every photo slot sat outside every guard in this repo while a Spanish
seller read them in English underneath a fully translated top bar.

The missing strings are not written like prose and cannot be found like prose.
They are written like this, in all 28 files that carry them:

    enum class PhotoSlotType(val wire: String, val label: String) {
        FRONT("front", "Front"),

So the rule is POSITIONAL, not textual. Find a constructor parameter whose name
says it is shown to someone, then read the argument at that position out of
every entry. Nothing about the string itself is consulted, and that is the
point: "Front" is indistinguishable from a wire value by inspection and
entirely distinguishable by where it sits.

⚠ A WIDER WALK WOULD NOT HAVE FOUND THIS, and it was proven before this file
was written (US-2976 AC8). A probe carrying BOTH `@Composable` (so it was
unambiguously in scope) and

    enum class ZzProbe(val route: String, val label: String) { ONE("one", "Marketplaces") }

was put in the source tree, and `no-bare-strings.py` reported OK across 108
Compose files. That guard looks for a literal at a Compose SINK - `Text(`,
`contentDescription =` - and a declaration site has none. Scope was never the
gap; what counts as copy was.
"""

import re

#: Constructor-parameter names that mean "a person reads this".
DISPLAY_ROLE = re.compile(
    r"^(label|title|displayName|caption|heading|shortLabel|subtitle)$"
)

#: `val label: String`, `var title: String?`, with or without a default.
CTOR_PARAM = re.compile(r"(?:val|var)\s+(\w+)\s*:\s*String")

#: The head of a primary constructor. The bracket is balanced separately.
CTOR_HEAD = re.compile(r"\b(?:enum\s+class|data\s+class|class)\s+\w+\s*\(")

#: `NAME(` at the head of an argument list: an enum entry or a constructor call.
ENTRY_HEAD = re.compile(r"(?:^|[\s,])([A-Za-z_]\w*)\s*\(")

#: `label = "Front"`, for the builders that name the argument instead.
NAMED_ARG = re.compile(
    r"\b(label|title|displayName|caption|heading|shortLabel|subtitle)"
    r'\s*=\s*"((?:[^"\\\n]|\\.)*)"'
)

#: The whole argument is one string literal and nothing else.
ONLY_LITERAL = re.compile(r'^"((?:[^"\\\n]|\\.)*)"$')


def balanced(src, open_at):
    """Text inside the bracket opening at `open_at`, and the index after it.

    Bracket counting rather than a regex, and string-aware. A default argument
    containing `)` would otherwise close the parameter list early, and every
    position after it would be read off by one - which reports the wrong
    strings rather than none, and looks like a working rule.
    """
    depth, i, n = 0, open_at, len(src)
    in_string = False
    while i < n:
        ch = src[i]
        if in_string:
            if ch == "\\":
                i += 2
                continue
            if ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
            if depth == 0:
                return src[open_at + 1 : i], i + 1
        i += 1
    return "", n


def split_args(text):
    """Top-level comma split, ignoring commas inside brackets or strings."""
    out, cur, depth, in_string = [], "", 0, False
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if in_string:
            cur += ch
            if ch == "\\":
                cur += text[i + 1] if i + 1 < n else ""
                i += 2
                continue
            if ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            cur += ch
        elif ch in "([{":
            depth += 1
            cur += ch
        elif ch in ")]}":
            depth -= 1
            cur += ch
        elif ch == "," and depth == 0:
            out.append(cur)
            cur = ""
        else:
            cur += ch
        i += 1
    if cur.strip():
        out.append(cur)
    return out


def display_positions(src):
    """{argument index: role} for every display-ish constructor parameter.

    Every class in the file contributes to one map. An entry list does not say
    which class it belongs to, and a position claimed by one class and not
    another costs a baseline line rather than a wrong build.
    """
    positions = {}
    for head in CTOR_HEAD.finditer(src):
        params, _ = balanced(src, head.end() - 1)
        for index, param in enumerate(split_args(params)):
            match = CTOR_PARAM.search(param)
            if match and DISPLAY_ROLE.match(match.group(1)):
                positions[index] = match.group(1)
    return positions


def labels_in(src):
    """Every literal sitting at a display position in this (comment-stripped) file.

    Two forms, because the codebase uses both: enum entries pass positionally
    and a scattering of call sites name the argument.
    """
    found = set()

    for match in NAMED_ARG.finditer(src):
        if match.group(2).strip():
            found.add(match.group(2))

    found |= display_bodies(src)

    positions = display_positions(src)
    if not positions:
        return found

    for head in ENTRY_HEAD.finditer(src):
        args = split_args(balanced(src, head.end() - 1)[0])
        for index in positions:
            if index >= len(args):
                continue
            literal = ONLY_LITERAL.match(args[index].strip())
            if literal and literal.group(1).strip():
                found.add(literal.group(1))
    return found


def self_test():
    """The rule has to still fire on the thing it was written for.

    Returns a list of failures, empty when healthy. The first case is the exact
    shape from US-2976: a five-item bottom bar whose labels every other guard in
    this repo reported as clean.
    """
    failures = []

    bottom_bar = (
        "enum class ShellSection(val route: String, val label: String) {\n"
        '    HOME("home", "Home"),\n'
        '    INVENTORY("inventory", "Inventory"),\n'
        '    MARKETPLACES("marketplaces", "Marketplaces"),\n'
        "}\n"
    )
    got = labels_in(bottom_bar)
    for want in ("Home", "Inventory", "Marketplaces"):
        if want not in got:
            failures.append(f"positional label {want!r} not found")
    if "home" in got:
        failures.append("the WIRE value at position 0 was read as a label")

    named = 'Chip(title = "Needs review", icon = Icons.Warning)\n'
    if "Needs review" not in labels_in(named):
        failures.append("a named `title =` argument was not found")

    # The third blind spot: a `when` inside a display-named function.
    when_body = (
        'fun eventLabel(type: String): String = when (type) {\n'
        '    "graded" -> "Condition graded"\n'
        "}\n"
    )
    got_when = labels_in(when_body)
    if "Condition graded" not in got_when:
        failures.append("a display-named function body was not read")
    if "graded" in got_when:
        failures.append("the WIRE value left of `->` was read as a label")

    no_role = (
        "enum class Wire(val code: String, val other: String) {\n"
        '    A("a", "Alpha"),\n'
        "}\n"
    )
    if labels_in(no_role):
        failures.append("a class with no display-ish parameter reported labels")

    # A default value containing a bracket must not shift the positions. This
    # is the failure that reports the WRONG strings rather than none.
    tricky = (
        "data class Row(val id: String = listOf(\")\").first(), val label: String) {\n"
        "}\n"
        'Row(id = "x", label = "Sold")\n'
    )
    if "Sold" not in labels_in(tricky):
        failures.append("a bracket inside a default value shifted the positions")

    return failures


#: A declaration whose NAME says a person reads what it returns.
DISPLAY_DECL = re.compile(
    r"\b(?:fun|val)\s+(\w*(?:[lL]abel|[tT]itle|[sS]ummary|[bB]lurb|[cC]aption|"
    r"[hH]eading|displayName|[sS]ubtitle))\b[^\n=]*?:\s*String\??\s*(?==|\{)"
)


def display_bodies(src):
    """Every string literal returned by a display-named declaration.

    THE THIRD BLIND SPOT (US-2976). The positional rule reads constructor
    arguments; a `when` inside a function has no argument position, so

        fun eventLabel(type: String): String = when (type) {
            "graded" -> "Condition graded"

    is invisible to it, and "Condition graded" is too short and too Title Case
    for the sentence rule. Measured 2026-08-30: 100 declarations in this app
    match DISPLAY_DECL.

    The body is taken from the `{` after the signature to its matching brace,
    or to the end of the line for a single-expression body. Bracket-counted for
    the same reason [balanced] is: a `)` or `}` inside a string would otherwise
    end the body early and report a prefix of it.
    """
    found = set()
    for match in DISPLAY_DECL.finditer(src):
        rest = src[match.end():]
        brace = rest.find("{")
        newline = rest.find("\n")
        if brace != -1 and (newline == -1 or brace < newline or rest[:brace].strip() in ("=", "= when", "")):
            body, _ = balanced(src, match.end() + brace)
        else:
            body = rest[: newline if newline != -1 else len(rest)]
        for value in _returned_literals(body):
            if value.strip():
                found.add(value)
    return found


#: Any string literal, escapes included.
ANY_LITERAL = re.compile(r'"((?:[^"\\\n]|\\.)*)"')


def _returned_literals(body):
    """The literals a display-named body RETURNS, not the ones it matches on.

    A `when` puts wire values on the left of `->` and copy on the right:

        "graded" -> "Condition graded"

    Taking every literal would report `graded` as a label, which is a wire
    value, and a baseline full of wire values is the place things go to be
    forgotten (the same mistake the positional rule made on ItemDraft.kt).
    """
    out = []
    for line in body.split("\n"):
        arrow = line.find("->")
        text = line[arrow + 2 :] if arrow != -1 else line
        out += [m.group(1) for m in ANY_LITERAL.finditer(text)]
    return out
