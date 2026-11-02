"""Bind one configured JUnit report to a gate receipt.

The gate commands write the report; this module only reads it. A report
problem is recorded as an error in the receipt and never changes the gate
verdict. The host publishes nothing for a report with an error.
"""

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import xml.etree.ElementTree as ElementTree

ENV = "CREW_TEST_REPORT_DIR"
PLACEHOLDER = re.compile(r"\{((?:suite\.)?[A-Za-z_][A-Za-z0-9_-]*)\}")


def config():
    """Return the repository testReport config, or None when it is not set."""
    text = os.environ.get("test_report", "").strip()
    if not text:
        return None
    value = json.loads(text)
    if not isinstance(value, dict) or set(value) != {"path", "format", "identity"}:
        raise ValueError("testReport needs exactly path, format and identity")
    path = value["path"]
    if (not isinstance(path, str) or not path or "\\" in path or PurePosixPath(path).is_absolute()
            or any(part in ("", ".", "..") for part in path.split("/"))):
        raise ValueError("testReport.path must be a relative path inside the report folder")
    if value["format"] != "junit":
        raise ValueError("testReport.format must be junit")
    identity = value["identity"]
    if (not isinstance(identity, str) or not PLACEHOLDER.search(identity)
            or "{" in PLACEHOLDER.sub("", identity) or "}" in PLACEHOLDER.sub("", identity)):
        raise ValueError("testReport.identity needs {attribute} or {suite.attribute} placeholders only")
    return value


def begin(folder):
    """Create a fresh, empty report folder for this gate run and export it.

    Returns None when no report is configured, or the receipt context.
    """
    try:
        settings = config()
    except ValueError as error:
        return {"error": str(error)}
    if settings is None:
        return None
    directory = folder / "test-report"
    directory.mkdir()
    os.environ[ENV] = str(directory)
    return {"settings": settings, "directory": directory}


def finish(state, started_at):
    """Return the receipt entry for begin() state, or None when not configured."""
    if state is None:
        return None
    if "error" in state:
        return {"error": f"invalid testReport config: {state['error']}"}
    return collect(state["settings"], state["directory"], started_at)


def cases(element, suite):
    """Yield (testcase, nearest testsuite) pairs in document order."""
    for child in element:
        if child.tag == "testsuite":
            yield from cases(child, child)
        elif child.tag == "testcase":
            yield child, suite


def mapped_name(identity, case, suite):
    def value(match):
        key = match.group(1)
        source, attribute = (suite, key[6:]) if key.startswith("suite.") else (case, key)
        text = source.get(attribute) if source is not None else None
        if text is None or not text.strip():
            raise ValueError(f"testcase {case.get('name')!r} has no {key} attribute for identity {identity!r}")
        return text.strip()
    return PLACEHOLDER.sub(value, identity)


# Executed-state attributes (GoogleTest dialect). Any other value is refused.
EXECUTED = {"status": {"run": False, "notrun": True}, "result": {"completed": False, "skipped": True, "suppressed": True}}


def not_executed(case, name):
    """Return True for an explicit non-executed case; refuse an unknown value."""
    skipped = False
    for attribute, values in EXECUTED.items():
        value = case.get(attribute)
        if value is None:
            continue
        if value not in values:
            raise ValueError(f"testcase {name!r} has unsupported {attribute}={value!r}")
        skipped = skipped or values[value]
    return skipped


def outcome(case, name):
    failure = next((child for child in case if child.tag in ("failure", "error")), None)
    if failure is not None:
        message = "\n".join(part.strip() for part in (failure.get("message") or "", failure.text or "")
                            if part and part.strip())
        return {"outcome": "fail", "message": message or failure.tag}
    if not_executed(case, name) or any(child.tag == "skipped" for child in case):
        return {"outcome": "skip"}
    return {"outcome": "pass"}


def parse(data, identity):
    try:
        root = ElementTree.fromstring(data)
    except ElementTree.ParseError as error:
        raise ValueError(f"report is not valid XML: {error}") from error
    if root.tag not in ("testsuites", "testsuite"):
        raise ValueError(f"report root is {root.tag!r}, not testsuites or testsuite")
    pairs = list(cases(root, root if root.tag == "testsuite" else None))
    if not pairs:
        raise ValueError("report has no testcase")
    results, seen = [], {}
    for case, suite in pairs:
        name = mapped_name(identity, case, suite)
        if name in seen:
            raise ValueError(f"ambiguous report: two testcases map to {name!r}")
        seen[name] = True
        result = {"test": name, **outcome(case, name)}
        time_text = case.get("time")
        if time_text is not None:
            try:
                seconds = float(time_text)
            except ValueError as error:
                raise ValueError(f"testcase {name!r} has invalid time {time_text!r}") from error
            if seconds >= 0 and seconds != float("inf"):
                result["time"] = seconds
        results.append(result)
    return results


def collect(settings, directory, started_at):
    """Return the receipt entry for the report. Never raises for report problems."""
    entry = {"path": settings["path"], "format": settings["format"], "identity": settings["identity"]}
    report = directory / settings["path"]
    try:
        if not report.resolve().is_relative_to(directory.resolve()):
            raise ValueError("report path leaves the report folder")
        if not report.is_file():
            raise ValueError(f"report is missing: {settings['path']}")
        data = report.read_bytes()
        if not data.strip():
            raise ValueError("report is empty")
        if report.stat().st_mtime < int(started_at):
            raise ValueError("report is stale: it is older than this gate run")
        entry["sha256"] = hashlib.sha256(data).hexdigest()
        # Parse exactly the bytes that were hashed.
        entry["results"] = parse(data, settings["identity"])
    except (OSError, ValueError, RecursionError) as error:
        entry.pop("results", None)
        entry["error"] = str(error)
    return entry
