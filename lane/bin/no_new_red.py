#!/usr/bin/env python3
"""Compare a candidate gate receipt with a red baseline receipt of the same target.

The last gate command is the designated test command. Its runner contract:
it writes a complete fresh JUnit report, exit 0 means every test passed,
exit 1 means the run completed with test failures, and any other exit is
incomplete. Every earlier gate command must pass. Nothing here runs a check.
"""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


def refuse(message):
    raise ValueError(f"no-new-red refused: {message}")


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *args], text=True, capture_output=True, timeout=120)


def load(path):
    """Return a validated receipt and its test outcomes by identity."""
    path = Path(path).resolve()
    receipt = json.loads(path.read_text())
    commands, checks = receipt.get("commands"), receipt.get("checks")
    if not isinstance(commands, list) or not commands or not isinstance(checks, list) or len(checks) != len(commands):
        refuse(f"incomplete gate plan in {path}")
    for index, (command, check) in enumerate(zip(commands, checks)):
        log = Path(check.get("log", "")).resolve()
        if check.get("command") != command or not log.is_relative_to(path.parent) or digest(log) != check.get("sha256"):
            refuse(f"gate log does not match {path}")
        allowed = (0, 1) if index == len(commands) - 1 else (0,)
        if check.get("timed_out") or check.get("exit_code") not in allowed or check.get("stdout_matches") is not True:
            refuse(f"gate {index + 1} exited {check.get('exit_code')} in {path}")
    if receipt.get("unchanged") is not True:
        refuse(f"checks changed the candidate in {path}")
    report = receipt.get("test_report")
    if not isinstance(report, dict) or report.get("error") or not isinstance(report.get("results"), list):
        refuse(f"no complete test report in {path}: {(report or {}).get('error', 'missing')}")
    file = (path.parent / "test-report" / report["path"]).resolve()
    if not file.is_relative_to(path.parent) or not file.is_file() or digest(file) != report.get("sha256"):
        refuse(f"test report does not match {path}")
    outcomes = {}
    for row in report["results"]:
        if row.get("test") in outcomes or row.get("outcome") not in ("pass", "fail", "skip"):
            refuse(f"duplicate or unknown test result in {path}")
        outcomes[row["test"]] = row["outcome"]
    failed = any(value == "fail" for value in outcomes.values())
    if failed != (checks[-1]["exit_code"] == 1):
        refuse(f"test command exit {checks[-1]['exit_code']} disagrees with its report in {path}")
    return receipt, outcomes


def compare(baseline_path, candidate_path, checkout):
    """Return the tolerated failures, or raise ValueError with the first violation."""
    baseline, before = load(baseline_path)
    candidate, after = load(candidate_path)
    if baseline["checks"][-1]["exit_code"] != 1:
        refuse("the baseline is not red in its designated test command")
    settings = ("path", "format", "identity")
    if (baseline["commands"] != candidate["commands"]
            or any(baseline["test_report"].get(key) != candidate["test_report"].get(key) for key in settings)
            or any(baseline.get(key) != candidate.get(key) for key in ("repository", "module", "cwd", "timeout_seconds"))):
        refuse("baseline and candidate used different commands, report settings or scope")
    tree = git(checkout, "rev-parse", baseline["base"] + "^{tree}")
    if tree.returncode != 0 or tree.stdout.strip() != baseline["tree"]:
        refuse("the baseline did not check the clean target tree")
    if git(checkout, "merge-base", "--is-ancestor", baseline["base"], candidate["base"]).returncode != 0:
        refuse("the candidate is not built on the baseline target")
    for test, outcome in before.items():
        if outcome in ("pass", "fail") and after.get(test) not in ("pass", "fail"):
            refuse(f"executed baseline test is {after.get(test, 'missing')} in the candidate: {test}")
    skipped = sorted(test for test, outcome in after.items() if outcome == "skip" and before.get(test) != "skip")
    if skipped:
        refuse(f"new skipped tests: {', '.join(skipped[:5])}")
    new = sorted(test for test, outcome in after.items() if outcome == "fail" and before.get(test) != "fail")
    if new:
        refuse(f"new failing tests: {', '.join(new[:5])}")
    return sorted(test for test, outcome in after.items() if outcome == "fail")


def pointer(root, settings):
    """Return the receipt pointer and the proof. A proof holds only for an opted-in Lander push without a pass."""
    if (root / "current.json").exists() or os.environ.get("NO_NEW_RED") != "last":
        return json.loads((root / "current.json").read_text()), None
    proof = json.loads((root / "no-new-red.json").read_text())
    candidate, baseline = Path(proof["candidate"]).resolve(), Path(proof["baseline"]).resolve()
    if (not baseline.is_relative_to(Path(os.environ["MEDULLA_RUN_DIR"]).resolve().parent)
            or digest(baseline) != proof["baseline_sha256"] or digest(candidate) != proof["candidate_sha256"]):
        refuse("the baseline is outside this batch, or a receipt has changed")
    report = json.loads(candidate.read_text()).get("test_report") or {}
    if not settings or any(report.get(key) != value for key, value in settings.items()):
        refuse("the candidate does not use the configured test report")
    compare(baseline, candidate, Path.cwd())
    return {"receipt": str(candidate), "sha256": proof["candidate_sha256"]}, proof


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "base":
        print(json.loads(Path(json.loads(Path(sys.argv[2]).read_text())["baseline"]).read_text())["base"])
        return
    if len(sys.argv) != 4 or sys.argv[1] != "compare":
        raise ValueError("usage: no_new_red.py compare BASELINE CANDIDATE | base PROOF")
    tolerated = compare(sys.argv[2], sys.argv[3], Path.cwd())
    print(json.dumps({"tolerated": tolerated}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
