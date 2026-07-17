#!/usr/bin/env python3
"""Validate a data-only brand-KB seed migration against the real PostgreSQL parser.

Docker is unreliable on the authoring host, so `npm run verify:db` cannot always
run. This is the fallback gate used for 00465..00468: it parses the file with
pglast (libpg_query — the actual server grammar), then checks the things a parse
alone does NOT catch and that have historically shipped broken:

  1. every VALUES tuple has exactly as many expressions as the INSERT's column list
  2. no INSERT contains two tuples with the same `on conflict` key
  3. every $j$...$j$ body is valid JSON, and contains no '' escape
     (inside a dollar-quoted string '' is TWO literal apostrophes, not one —
     the trap that silently corrupts a note)

A GREEN RUN IS ONLY MEANINGFUL IF THE SCANNER CAN GO RED. A vacuous scan (zero
$j$ bodies matched, wrong path, etc.) prints "no problems" and reads as a clean
bill of health — that has shipped twice. So this reports WHAT IT SCANNED, and
`--selftest` proves the checks fire by planting a bug of each class into a real
seed and asserting each is caught. Run --selftest before trusting a green run.

Note: invoke as `python` (NOT `python3` — it does not exist on the authoring
host). Requires pglast (v8.2 installed).

Usage: python scripts/ralph/validate-seed-sql.py supabase/migrations/00468_*.sql
       python scripts/ralph/validate-seed-sql.py --selftest <a-real-seed.sql>
"""
import json
import re
import sys
import tempfile

from pglast import parse_sql
from pglast.stream import RawStream  # noqa: F401  (import proves the lib is sane)
from pglast import ast


class SeedError(Exception):
    """A check fired. Raised (not sys.exit) so --selftest can assert it."""


def fail(msg):
    raise SeedError(msg)


def check_dollar_quoted(sql):
    """Every $j$...$j$ body must be valid JSON with no '' escape."""
    bodies = re.findall(r"\$j\$(.*?)\$j\$", sql, re.DOTALL)
    for i, body in enumerate(bodies, 1):
        if "''" in body:
            ctx = body[max(0, body.index("''") - 60):body.index("''") + 60]
            fail(f"$j$ body #{i} contains '' (two literal apostrophes inside a "
                 f"dollar-quoted string, not an escape): ...{ctx}...")
        try:
            json.loads(body)
        except json.JSONDecodeError as e:
            fail(f"$j$ body #{i} is not valid JSON: {e}")
    return len(bodies)


def conflict_key_indexes(stmt, cols):
    """Column indexes of the ON CONFLICT target, or None."""
    oc = stmt.onConflictClause
    if oc is None or oc.infer is None or oc.infer.indexElems is None:
        return None
    names = [e.name for e in oc.infer.indexElems]
    try:
        return [cols.index(n) for n in names]
    except ValueError:
        return None


def literal(node):
    """A hashable rendering of a VALUES expression, for dup detection."""
    if isinstance(node, ast.A_Const):
        return str(getattr(node.val, "sval", getattr(node.val, "ival", None)))
    if isinstance(node, ast.TypeCast):
        return literal(node.arg)
    return None


def main(path, quiet=False):
    sql = open(path, encoding="utf-8").read()

    stmts = parse_sql(sql)          # raises on a syntax error
    inserts = 0
    shapes = []

    for raw in stmts:
        stmt = raw.stmt
        if not isinstance(stmt, ast.InsertStmt):
            continue
        inserts += 1
        cols = [c.name for c in (stmt.cols or [])]
        sel = stmt.selectStmt
        if sel is None or not getattr(sel, "valuesLists", None):
            continue
        tuples = sel.valuesLists

        # 1. arity
        for n, tup in enumerate(tuples, 1):
            if len(tup) != len(cols):
                fail(f"{path}: INSERT #{inserts} tuple #{n} has {len(tup)} "
                     f"expressions but the column list has {len(cols)}")
        shapes.append(f"{len(tuples)}x{len(cols)}")

        # 2. duplicate conflict keys
        idxs = conflict_key_indexes(stmt, cols)
        if idxs:
            seen = {}
            for n, tup in enumerate(tuples, 1):
                key = tuple(literal(tup[i]) for i in idxs)
                if None in key:
                    continue
                if key in seen:
                    fail(f"{path}: INSERT #{inserts} tuples #{seen[key]} and #{n} "
                         f"share the on-conflict key {key} — the second silently "
                         f"clobbers the first")
                seen[key] = n

    # 3. dollar-quoted bodies
    bodies = check_dollar_quoted(sql)

    if quiet:
        return

    print(f"OK {path}")
    print(f"  parses: {len(stmts)} statements")
    print(f"  insert shapes (tuples x cols): {', '.join(shapes)}")
    print(f"  $j$ bodies scanned: {bodies} (valid JSON, no '' trap)")


def plant(sql, bug):
    """Inject one bug of the given class into a known-clean seed."""
    if bug == "quote":
        i = sql.index("$j$")
        return sql[:i + 3] + '{"planted": "men\'\'s"}, ' + sql[i + 4:]
    if bug == "json":
        i = sql.index("$j$")
        return sql[:i + 3] + "{,,," + sql[i + 3:]
    if bug == "arity":
        i = sql.lower().index("values")
        j = sql.index("(", i)
        return sql[:j + 1] + "'planted_extra_column'," + sql[j + 1:]
    raise AssertionError(bug)


def selftest(path):
    """Prove each check can go red. A scanner that cannot fail proves nothing."""
    clean = open(path, encoding="utf-8").read()

    # The clean file must pass, or the fixture is not a valid baseline.
    main(path, quiet=True)
    print(f"selftest: baseline {path} passes")

    for bug in ("quote", "json", "arity"):
        with tempfile.NamedTemporaryFile(
            "w", suffix=".sql", encoding="utf-8", delete=False
        ) as fh:
            fh.write(plant(clean, bug))
            bugged = fh.name
        try:
            main(bugged, quiet=True)
        except SeedError as e:
            print(f"selftest: planted '{bug}' CAUGHT -> {str(e)[:70]}...")
        else:
            print(f"selftest FAILED: planted '{bug}' was NOT caught — "
                  f"this scanner's green runs are worthless")
            sys.exit(1)

    print("selftest OK: all 3 planted bugs caught; a green run means something.")


if __name__ == "__main__":
    try:
        if len(sys.argv) == 3 and sys.argv[1] == "--selftest":
            selftest(sys.argv[2])
        elif len(sys.argv) == 2 and not sys.argv[1].startswith("--"):
            main(sys.argv[1])
        else:
            print(__doc__)
            sys.exit(2)
    except SeedError as e:
        print(f"FAIL: {e}")
        sys.exit(1)
