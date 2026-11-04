"""Bind the coder's test names to the reviewed gate receipt.

The coder writes artifacts/test-bindings.json: [{task, ac, check, test}].
Each (task, ac, check) of the package data.acceptance needs at least one test with outcome pass
in the test report of the receipt that this run produced. The record binds the file digest to that
exact receipt and tree. The host recomputes every check at completion. Each refusal is an evidence gap.
"""

import hashlib
import json
import os
from pathlib import Path

import test_report

RECORD = "test-bindings-receipt.json"
BINDINGS = "test-bindings.json"
# Joppa limits each changed scalar data value, also inside lists and objects.
MAX_VALUE = 1024


class Refused(ValueError):
    def __init__(self, code, message):
        super().__init__(f"{code}: {message}")
        self.code = code


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def required(ticket):
    """The (task, ac, check) rows of every package Task with data.acceptance, in ticket order."""
    rows = []
    for task in ticket.get("tasks") or [ticket]:
        for row in task.get("testAcceptance") or []:
            key = (task["address"], row["ac"], row["check"])
            if key not in rows:
                rows.append(key)
    return rows


def parse(value):
    """Validate the coder rows and remove identical rows."""
    if not isinstance(value, list) or not value:
        raise Refused("BINDING_INVALID", f"{BINDINGS} needs a nonempty list")
    rows = []
    for row in value:
        if (not isinstance(row, dict) or set(row) != {"task", "ac", "check", "test"}
                or not all(isinstance(row[name], str) and row[name].strip() and len(row[name]) <= MAX_VALUE
                           for name in row)):
            raise Refused("BINDING_INVALID", f"each binding needs exactly task, ac, check and test "
                                             f"of at most {MAX_VALUE} characters")
        item = {"task": row["task"], "ac": row["ac"], "check": row["check"], "test": row["test"]}
        if item not in rows:
            rows.append(item)
    return rows


def check(rows, expected, report, limit):
    pairs = {(row["task"], row["ac"], row["check"]) for row in rows}
    missing, extra = set(expected) - pairs, pairs - set(expected)
    if missing or extra:
        raise Refused("BINDING_INVALID", f"bindings differ from data.acceptance: missing {sorted(missing)}; "
                                         f"extra {sorted(extra)}")
    if not isinstance(report, dict) or report.get("error") or not isinstance(report.get("results"), list):
        detail = report.get("error") if isinstance(report, dict) else None
        raise Refused("BINDING_NO_REPORT", "the gate receipt has no usable test report" + (f": {detail}" if detail else ""))
    outcomes = {item.get("test"): item.get("outcome") for item in report["results"]}
    for row in rows:
        if row["test"] not in outcomes:
            raise Refused("BINDING_NOT_IN_REPORT", f"{row['test']} is not in the gate test report")
        if outcomes[row["test"]] != "pass":
            raise Refused("BINDING_NOT_PASSED", f"{row['test']} has outcome {outcomes[row['test']]}")
    nodes = {(row["ac"], row["test"]) for row in rows}
    if isinstance(limit, int) and len(nodes) > limit:
        raise Refused("PACKAGE_BUDGET", f"{len(nodes)} distinct criterion tests exceed the {limit} node saves "
                                        "that the completion batch can hold")


def write(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def invalidate(gates):
    """A new gate run makes any earlier record stale."""
    (gates.parent / RECORD).unlink(missing_ok=True)


def bind(gates, receipt_path=None):
    """gates is artifacts/gates. gates.py run binds each passing receipt before it becomes current.
    gates.py bindings binds the current receipt again. Neither runs a check."""
    artifacts = gates.parent
    record = artifacts / RECORD
    # Invalidate an earlier record before any check.
    invalidate(gates)
    ticket_file = artifacts / "ticket.json"
    # The host recomputes the required rows from its claim. A missing ticket file only skips this early check.
    ticket = json.loads(ticket_file.read_text()) if ticket_file.is_file() else {}
    expected = required(ticket) if ticket else []
    if not expected:
        print("bindings: no Task data.acceptance; nothing to bind")
        return
    if receipt_path is None:
        pointer = json.loads((gates / "current.json").read_text())
        receipt_path = Path(pointer["receipt"]).resolve()
        if not receipt_path.is_relative_to(gates.resolve()) or digest(receipt_path) != pointer["sha256"]:
            raise Refused("BINDING_FROZEN_MISMATCH", "gate receipt is outside this run or has changed")
    receipt_path = Path(receipt_path).resolve()
    receipt = json.loads(receipt_path.read_text())
    base = {"schema": 1, "receipt": str(receipt_path), "receipt_sha256": digest(receipt_path),
            "tree": receipt["tree"], "candidate_sha": receipt["candidate_sha"]}
    # A final Requirement landing of a verification run clears VERIFY_ONLY and keeps this marker.
    if "true" in (os.environ.get("VERIFY_ONLY"), os.environ.get("TEST_BINDINGS_VERIFY_ONLY")):
        # No coder ran. The host reports the gap; no test acceptance is recorded.
        write(record, {**base, "status": "verify_only"})
        print("bindings: BINDING_MISSING: verification run has no coder bindings")
        return
    if test_report.config() is None:
        write(record, {**base, "status": "no_report"})
        print("bindings: BINDING_NO_REPORT: repository has no testReport; no test acceptance is recorded")
        return
    file = artifacts / BINDINGS
    if not file.is_file():
        raise Refused("BINDING_MISSING", f"write {file} with one verified test for each Task acceptance check")
    try:
        value = json.loads(file.read_text())
    except ValueError as error:
        raise Refused("BINDING_INVALID", f"{BINDINGS} is not valid JSON: {error}") from None
    rows = parse(value)
    check(rows, expected, receipt.get("test_report"), ticket.get("bindingNodeLimit"))
    write(record, {**base, "status": "bound", "bindings_sha256": digest(file), "rows": rows})
    print(f"bindings: {len(rows)} bindings for {len(expected)} acceptance checks; record {record}")
