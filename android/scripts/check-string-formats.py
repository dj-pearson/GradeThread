#!/usr/bin/env python3
"""US-2368 — fail CI if a stringResource call's argument count does not match
the resource's positional placeholders, and if a translation drifts from the
default language.

A mismatch is not a compile error. `stringResource(R.string.x, a)` against a
resource holding `%1$s %2$s` compiles perfectly and throws
`MissingFormatArgumentException` the moment that screen is drawn — in whichever
language the translator happened to add a placeholder to.

A call with NO arguments is allowed and deliberate: it reads the raw template so
it can be `.format(...)`ed later, which is how a per-row string is built inside a
`joinToString` lambda (not a composable scope, so `stringResource` cannot be
called there).

Since Spanish landed there is a second job here: every `values-<tag>/strings.xml`
must hold the same names as `values/` with the same placeholders, and the three
places that decide which languages exist — the `values-<tag>/` directories,
`res/xml/locales_config.xml`, and `AppLocale.SUPPORTED` — must agree. A language
listed in only two of the three either shows up in the picker and changes
nothing, or ships strings nobody can reach.

Run locally:  python3 android/scripts/check-string-formats.py
"""
import os
import re
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "app", "src", "main", "java")
RESOURCES = os.path.join(ROOT, "app", "src", "main", "res")
STRINGS = os.path.join(RESOURCES, "values", "strings.xml")
LOCALES_CONFIG = os.path.join(RESOURCES, "xml", "locales_config.xml")
APP_LOCALE = os.path.join(
    SOURCE, "com", "gradethread", "app", "platform", "locale", "AppLocale.kt"
)
DEFAULT_TAG = "en"

CALL = re.compile(r"\b(pluralStringResource|stringResource)\s*\(")
RESOURCE_ID = re.compile(r"R\.(string|plurals)\.([a-z0-9_]+)")
PLACEHOLDER = re.compile(r"%(\d+)\$[sd]")


def placeholders(text):
    return {int(index) for index in PLACEHOLDER.findall(text or "")}


def load_spec(path=STRINGS):
    spec, seen, ragged = {}, [], []
    for element in ET.parse(path).getroot():
        seen.append(element.get("name"))
        if element.tag == "string":
            spec[("string", element.get("name"))] = placeholders(element.text)
        elif element.tag == "plurals":
            found, per_quantity = set(), {}
            for item in element:
                per_quantity[item.get("quantity")] = placeholders(item.text)
                found |= placeholders(item.text)
            # Every quantity form must take the SAME arguments. A translator who
            # adds a `few` form and drops a placeholder crashes the app in that
            # language only — nowhere a test written in English would see it.
            if len({frozenset(v) for v in per_quantity.values()}) > 1:
                ragged.append((element.get("name"), per_quantity))
            spec[("plurals", element.get("name"))] = found
    duplicates = sorted({name for name in seen if seen.count(name) > 1})
    return spec, duplicates, ragged


def translated_tags():
    """The languages that actually have a strings.xml, `en` for the default."""
    tags = {DEFAULT_TAG}
    for name in sorted(os.listdir(RESOURCES)):
        if not name.startswith("values-"):
            continue
        if not os.path.exists(os.path.join(RESOURCES, name, "strings.xml")):
            continue
        qualifier = name[len("values-"):]
        # Skip non-language qualifiers (values-night, values-v31, values-sw600dp).
        if re.fullmatch(r"[a-z]{2,3}(-r[A-Z]{2})?", qualifier):
            tags.add(qualifier.replace("-r", "-"))
    return tags


def check_translations(spec):
    """Every translation carries the same names and placeholders as `values/`."""
    failures = []
    for tag in sorted(translated_tags() - {DEFAULT_TAG}):
        directory = "values-" + tag.replace("-", "-r")
        path = os.path.join(RESOURCES, directory, "strings.xml")
        translated, duplicates, ragged = load_spec(path)
        for name in duplicates:
            failures.append(f"{directory}: duplicate resource name {name}")
        for name, per_quantity in ragged:
            failures.append(f"{directory}: plural {name} forms disagree on arguments")
        for key in sorted(set(spec) - set(translated)):
            failures.append(f"{directory}: missing {key[0]} {key[1]}")
        for key in sorted(set(translated) - set(spec)):
            # aapt's ExtraTranslation: a name that no longer exists in the
            # default file is dead weight nothing can ever read.
            failures.append(f"{directory}: {key[1]} is not in values/strings.xml")
        for key in sorted(set(spec) & set(translated)):
            if spec[key] != translated[key]:
                mine = ", ".join(f"%{i}$" for i in sorted(translated[key])) or "none"
                theirs = ", ".join(f"%{i}$" for i in sorted(spec[key])) or "none"
                failures.append(
                    f"{directory}: {key[1]} has {mine}, values/ has {theirs}"
                )
    return failures


def check_language_list():
    """`values-<tag>/`, locales_config.xml and AppLocale.SUPPORTED name the same
    languages. Any two of the three agreeing is not enough: a locale in the
    config with no strings gives a picker entry that changes nothing, and a
    translation nobody lists is never reachable."""
    shipped = translated_tags()
    configured = set(
        re.findall(
            r'<locale\s+android:name="([^"]+)"',
            open(LOCALES_CONFIG, "r", encoding="utf-8").read(),
        )
    )
    source = open(APP_LOCALE, "r", encoding="utf-8").read()
    block = re.search(r"val SUPPORTED[^=]*=\s*listOf\((.*?)\n    \)", source, re.S)
    offered = set(re.findall(r'Option\("([^"]+)"', block.group(1) if block else ""))

    failures = []
    for label, found in (("locales_config.xml", configured), ("AppLocale.SUPPORTED", offered)):
        for tag in sorted(found - shipped):
            failures.append(f"{label} offers {tag}, but there is no values-{tag}/strings.xml")
        for tag in sorted(shipped - found):
            failures.append(f"values-{tag}/strings.xml exists, but {label} does not list it")
    return failures


def split_args(text):
    args, depth, current = [], 0, ""
    for char in text:
        if char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
        if char == "," and depth == 0:
            args.append(current)
            current = ""
        else:
            current += char
    if current.strip():
        args.append(current)
    return [arg.strip() for arg in args if arg.strip()]


def blank_comments(source):
    """Replace comment bodies with spaces, keeping every offset intact.

    US-2976: a `//` comment sitting between two arguments broke the argument
    COUNT, because a comma inside it is a comma at depth zero. That direction
    is only noisy. The other direction is not: an unmatched `(` or `)` in a
    comment moves the closing paren this scanner thinks it found, and a call
    that then looks like it passes the right number of arguments is a silent
    pass against a crash.

    Offsets are preserved rather than the text removed, so the reported line
    number still points at the real line.
    """
    out, i, n = [], 0, len(source)
    while i < n:
        char = source[i]
        if char == '"':
            # A `//` inside a string literal is a URL, not a comment.
            triple = source.startswith('\"\"\"', i)
            end = i + (3 if triple else 1)
            close = '\"\"\"' if triple else '"'
            while end < n:
                if not triple and source[end] == "\\":
                    end += 2
                    continue
                if source.startswith(close, end):
                    end += len(close)
                    break
                if not triple and source[end] == "\n":
                    break
                end += 1
            out.append(source[i:end])
            i = end
        elif source.startswith("//", i):
            end = source.find("\n", i)
            end = n if end == -1 else end
            out.append(" " * (end - i))
            i = end
        elif source.startswith("/*", i):
            end = source.find("*/", i + 2)
            end = n if end == -1 else end + 2
            # Newlines are kept so the line count does not shift.
            out.append("".join("\n" if c == "\n" else " " for c in source[i:end]))
            i = end
        else:
            out.append(char)
            i += 1
    return "".join(out)


def scan(path, spec):
    return scan_source(open(path, "r", encoding="utf-8").read(), spec)


def scan_source(raw, spec):
    source = blank_comments(raw)
    failures = []
    for match in CALL.finditer(source):
        depth, end = 0, len(source)
        for index in range(match.end() - 1, len(source)):
            if source[index] == "(":
                depth += 1
            elif source[index] == ")":
                depth -= 1
                if depth == 0:
                    end = index
                    break
        args = split_args(source[match.end():end])
        if not args:
            continue
        identifier = RESOURCE_ID.search(args[0])
        if not identifier:
            continue
        key = (identifier.group(1), identifier.group(2))
        if key not in spec:
            failures.append((source[:match.start()].count("\n") + 1, f"{key[1]} is not declared"))
            continue
        # pluralStringResource takes (id, count, ...formatArgs).
        supplied = len(args) - (2 if match.group(1) == "pluralStringResource" else 1)
        expected = len(spec[key])
        if supplied == 0 or supplied == expected:
            continue
        failures.append((
            source[:match.start()].count("\n") + 1,
            f"{key[1]} declares {expected} placeholder(s), call passes {supplied}",
        ))
    return failures


def self_test():
    """Prove blank_comments is doing the three things it is here to do.

    A guard that quietly stops guarding reads exactly like a clean codebase, so
    each case below is written to FAIL if the stripper is removed or reduced to
    a no-op — the third one is the expensive direction, where a paren in a
    comment moves the closing paren and a genuine mismatch is never reported.
    """
    spec = {("string", "two"): {1, 2}, ("string", "one"): {1}}
    cases = [
        (
            "a comma in a comment is not an argument separator",
            'stringResource(\n  R.string.two,\n  a,\n  // one, two, three\n  b,\n)',
            0,
        ),
        (
            "a // inside a string literal is a URL, not a comment",
            'stringResource(R.string.two, "https://a.example", b)',
            0,
        ),
        (
            # The expensive direction: a stray `)` in a comment closes the call
            # early, so a 3-argument call is measured as a 2-argument one and
            # matches the resource exactly. Nothing is printed, and the app
            # still throws the moment the screen draws.
            "a stray paren in a comment does not truncate the call",
            'stringResource(\n  R.string.two,\n  a,\n  b,\n  // trailing )\n  c,\n)',
            1,
        ),
        (
            # Same idea for /* */, and phrased as a comma rather than a paren:
            # a leftover `/*` fragment would count as an argument by itself and
            # make a paren case pass for the wrong reason.
            "a comma in a block comment is not an argument separator either",
            'stringResource(\n  R.string.two,\n  a, /* x, y */\n  b,\n)',
            0,
        ),
    ]
    broken = []
    for name, source, expected in cases:
        found = len(scan_source(source, spec))
        if found != expected:
            broken.append(f"{name}: expected {expected} failure(s), got {found}")
    return broken


#: A `'` that is not escaped, inside a <string> value.
BARE_APOSTROPHE = re.compile(r"<string name=\"[a-z0-9_]+\">([^<]*)</string>")


def check_apostrophes():
    """aapt2 rejects an unescaped `'` in a string value, and says so uselessly.

    US-2976: the build fails with "Can not extract resource from
    com.android.aaptcompiler.ParsedResource@3f054c72" and a line number from the
    MERGED values.xml, which is thousands of lines from the file anyone edits.
    It cost two debugging rounds on two different days before it was recognised
    on sight. The repo convention is `\\'`, and this says so by name.
    """
    failures = []
    for tag in sorted(translated_tags()):
        directory = "values" if tag == DEFAULT_TAG else "values-" + tag.replace("-", "-r")
        path = os.path.join(RESOURCES, directory, "strings.xml")
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as fh:
            for line_no, line in enumerate(fh, start=1):
                match = BARE_APOSTROPHE.search(line)
                if not match:
                    continue
                if re.search(r"(?<!\\)'", match.group(1)):
                    failures.append(
                        f"{directory}/strings.xml:{line_no}: unescaped apostrophe "
                        f"-- aapt2 rejects this. Write \\\\' instead."
                    )
    return failures


def main():
    broken = self_test()
    if broken:
        print("check-string-formats: the scanner itself is broken\n", file=sys.stderr)
        for message in broken:
            print(f"  {message}", file=sys.stderr)
        return 1

    spec, duplicates, ragged = load_spec()
    if ragged:
        print("check-string-formats: plural forms disagree on arguments\n", file=sys.stderr)
        for name, per_quantity in ragged:
            print(f"  {name}", file=sys.stderr)
            for quantity, indexes in sorted(per_quantity.items()):
                shown = ", ".join(f"%{i}$" for i in sorted(indexes)) or "none"
                print(f"    {quantity}: {shown}", file=sys.stderr)
        return 1

    if duplicates:
        # aapt2 rejects these outright, so the build dies before any test runs —
        # and the message it prints does not name the file the second one came
        # from. Cheaper to catch here.
        print("check-string-formats: duplicate resource names\n", file=sys.stderr)
        for name in duplicates:
            print(f"  {name}", file=sys.stderr)
        return 1

    drift = check_language_list() + check_translations(spec) + check_apostrophes()
    if drift:
        print("check-string-formats: translations have drifted\n", file=sys.stderr)
        for message in drift:
            print(f"  {message}", file=sys.stderr)
        return 1

    failures = []
    for directory, _, names in os.walk(SOURCE):
        for name in names:
            if not name.endswith(".kt"):
                continue
            path = os.path.join(directory, name)
            for line_no, message in scan(path, spec):
                failures.append((os.path.relpath(path, ROOT), line_no, message))

    if not failures:
        languages = ", ".join(sorted(translated_tags()))
        print(f"check-string-formats: OK ({len(spec)} resources, {languages})")
        return 0

    print("check-string-formats: argument count does not match the resource\n", file=sys.stderr)
    for rel, line_no, message in failures:
        print(f"  {rel}:{line_no}: {message}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
