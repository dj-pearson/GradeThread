#!/usr/bin/env python3
"""US-2368 — fail CI if a stringResource call's argument count does not match
the resource's positional placeholders.

A mismatch is not a compile error. `stringResource(R.string.x, a)` against a
resource holding `%1$s %2$s` compiles perfectly and throws
`MissingFormatArgumentException` the moment that screen is drawn — in whichever
language the translator happened to add a placeholder to.

A call with NO arguments is allowed and deliberate: it reads the raw template so
it can be `.format(...)`ed later, which is how a per-row string is built inside a
`joinToString` lambda (not a composable scope, so `stringResource` cannot be
called there).

Run locally:  python3 android/scripts/check-string-formats.py
"""
import os
import re
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "app", "src", "main", "java")
STRINGS = os.path.join(ROOT, "app", "src", "main", "res", "values", "strings.xml")

CALL = re.compile(r"\b(pluralStringResource|stringResource)\s*\(")
RESOURCE_ID = re.compile(r"R\.(string|plurals)\.([a-z0-9_]+)")
PLACEHOLDER = re.compile(r"%(\d+)\$[sd]")


def placeholders(text):
    return {int(index) for index in PLACEHOLDER.findall(text or "")}


def load_spec():
    spec, seen = {}, []
    for element in ET.parse(STRINGS).getroot():
        seen.append(element.get("name"))
        if element.tag == "string":
            spec[("string", element.get("name"))] = placeholders(element.text)
        elif element.tag == "plurals":
            found = set()
            for item in element:
                found |= placeholders(item.text)
            spec[("plurals", element.get("name"))] = found
    duplicates = sorted({name for name in seen if seen.count(name) > 1})
    return spec, duplicates


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


def scan(path, spec):
    source = open(path, "r", encoding="utf-8").read()
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


def main():
    spec, duplicates = load_spec()
    if duplicates:
        # aapt2 rejects these outright, so the build dies before any test runs —
        # and the message it prints does not name the file the second one came
        # from. Cheaper to catch here.
        print("check-string-formats: duplicate resource names\n", file=sys.stderr)
        for name in duplicates:
            print(f"  {name}", file=sys.stderr)
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
        print(f"check-string-formats: OK ({len(spec)} resources)")
        return 0

    print("check-string-formats: argument count does not match the resource\n", file=sys.stderr)
    for rel, line_no, message in failures:
        print(f"  {rel}:{line_no}: {message}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
