"""Verify strict file samples without changing the original gate results."""
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import time
import uuid

import no_new_red
import test_report

_active = None
KEY = "not_reproduced"
FIELDS = ("task", "run", "repository", "module", "cwd", "base", "tree", "commands", "timeout_seconds")


def stop():
    """Stop the active sample with the existing gate cleanup grace."""
    global _active
    if _active is None:
        return True
    from gates import stop_group
    try:
        return stop_group(_active)
    finally:
        _active = None


def policy():
    text = os.environ.get("NOT_REPRODUCED", "").strip()
    if not text:
        return None
    value = json.loads(text)
    if (not isinstance(value, dict) or set(value) != {"command", "attempts"}
            or type(value["attempts"]) is not int or value["attempts"] not in (1, 2)
            or not isinstance(value["command"], list) or not value["command"]
            or any(not isinstance(arg, str) or not arg or "\0" in arg for arg in value["command"])):
        raise ValueError("invalid NOT_REPRODUCED policy")
    return value


def hashed(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def confined(root, value):
    path = Path(value).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError("retry artifact leaves its receipt directory or is missing")
    return path


def git(*args):
    return subprocess.check_output(["git", *args], text=True, stderr=subprocess.PIPE, timeout=120,
                                   env={**os.environ, "GIT_LITERAL_PATHSPECS": "1"}).strip()


def scope(receipt):
    value = {key: receipt[key] for key in FIELDS}
    expected = {"task": os.environ["ticket_id"], "run": str(Path(os.environ["MEDULLA_RUN_DIR"]).resolve()),
                "repository": os.environ["project_dir"], "module": os.environ["module_name"],
                "cwd": str(Path.cwd().resolve())}
    if (any(value[key] != item for key, item in expected.items()) or git("rev-parse", "HEAD") != value["base"]
            or git("rev-parse", "HEAD^{tree}") != value["tree"] or git("status", "--porcelain")
            or type(value["timeout_seconds"]) is not int or value["timeout_seconds"] < 1):
        raise ValueError("retry scope, candidate or clean tree changed")
    return value


def report(root, entry, started=None):
    settings = test_report.config()
    if (not isinstance(entry, dict) or not settings
            or any(entry.get(key) != item for key, item in settings.items()) or entry.get("error")):
        raise ValueError("retry report settings changed or report is incomplete")
    file = confined(root, root / "test-report" / entry["path"])
    data = file.read_bytes()
    if hashlib.sha256(data).hexdigest() != entry.get("sha256"):
        raise ValueError("retry report hash changed")
    if started is not None and file.stat().st_mtime < int(started):
        raise ValueError("retry report is stale")
    rows = test_report.parse(data, settings["identity"])
    if rows != entry.get("results"):
        raise ValueError("retry report results differ from hashed XML")
    return rows


def initial(path, receipt):
    no_new_red.load(path, receipt)
    context = scope(receipt)
    if (receipt.get("unchanged") is not True or receipt.get("passed") is not False or KEY in receipt
            or any(type(check["exit_code"]) is not int for check in receipt["checks"])):
        raise ValueError("initial gate is incomplete")
    if receipt["checks"][-1]["exit_code"] != 1:
        raise ValueError("initial test command is not red")
    rows = report(path.parent, receipt["test_report"], min(check["started_at"] for check in receipt["checks"]))
    if any(row["outcome"] != "skip" and not row["file"] for row in rows):
        raise ValueError("an executed identity has no file")
    files = sorted({row["file"] for row in rows if row["outcome"] == "fail"}, key=str)
    if not files:
        raise ValueError("initial gate has no failed file")
    for file in files:
        if (not isinstance(file, str) or not file or file.startswith(("/", "-")) or "\\" in file
                or any(part in ("", ".", "..") for part in file.split("/")) or any(ord(c) < 32 for c in file)
                or not (Path.cwd() / file).resolve().is_relative_to(Path.cwd().resolve())):
            raise ValueError("failed test has no safe relative file")
        if (git("ls-files", "--error-unmatch", "--", file) != file
                or not Path(file).is_file() or Path(file).is_symlink()):
            raise ValueError("failed file is not one tracked regular file")
    return context, rows, files


def sample(folder, receipt, config, file, attempt):
    global _active
    folder.mkdir()
    previous = os.environ.get(test_report.ENV)
    state = test_report.begin(folder)
    argv, started = config["command"] + [file], time.time()
    log = folder / "output.log"
    process = None
    try:
        with log.open("xb") as output:
            process = subprocess.Popen(argv, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            _active = process
            try:
                code = process.wait(timeout=receipt["timeout_seconds"])
                if not stop():
                    code = 125
            except subprocess.TimeoutExpired:
                stop()
                process.wait(timeout=5)
                code = 124
        entry = test_report.finish(state, started)
    finally:
        _active = None
        if previous is None:
            os.environ.pop(test_report.ENV, None)
        else:
            os.environ[test_report.ENV] = previous
    value = {"file": file, "attempt": attempt, "argv": argv, "scope": scope(receipt),
             "base": receipt["base"], "tree": receipt["tree"], "directory": str(folder),
             "exit_code": code, "started_at": started, "finished_at": time.time(),
             "log": str(log), "sha256": hashed(log), "test_report": entry}
    value["result"] = ("green" if code == 0 and entry and entry.get("results") and not entry.get("error")
                       and all(row["outcome"] in ("pass", "skip") for row in entry["results"]) else "red" if code == 1 else "incomplete")
    (folder / "sample.json").write_text(json.dumps(value, indent=2) + "\n")
    return value


def checked_sample(root, value, context, config, file, attempt, expected):
    folder = Path(value["directory"]).resolve()
    if not folder.is_relative_to(root) or folder == root:
        raise ValueError("sample directory leaves the original receipt")
    log = confined(folder, value["log"])
    if (value["scope"] != context or value["base"] != context["base"] or value["tree"] != context["tree"]
            or value["argv"] != config["command"] + [file] or value["file"] != file
            or type(value["attempt"]) is not int or value["attempt"] != attempt
            or type(value["exit_code"]) is not int or value["exit_code"] != 0
            or value["result"] != "green"
            or hashed(log) != value["sha256"]
            or any(type(value[key]) not in (int, float) or not math.isfinite(value[key]) for key in ("started_at", "finished_at"))
            or value["finished_at"] < value["started_at"]):
        raise ValueError("sample command, scope, result, time or log differs")
    rows = report(folder, value["test_report"], value["started_at"])
    passed = {row["test"] for row in rows if row["outcome"] == "pass"}
    if (any(row["file"] != file or (row["outcome"] != "pass"
            and not (row["outcome"] == "skip" and expected.get(row["test"]) == "skip")) for row in rows)
            or not {name for name, outcome in expected.items() if outcome != "skip"}.issubset(passed)):
        raise ValueError("sample omits or skips an executed identity, or has a failure")


def run(path, receipt):
    """Return a proof only when every configured sample passes completely."""
    try:
        config = policy()
        if config is None:
            return None
        path = Path(path).resolve()
        context, rows, files = initial(path, receipt)
        original = path.parent / "initial.json"
        temporary = path.parent / ("initial-" + uuid.uuid4().hex + ".tmp")
        try:
            with temporary.open("x") as output:
                json.dump(receipt, output, indent=2)
                output.write("\n")
            os.link(temporary, original)
        finally:
            temporary.unlink(missing_ok=True)
        proof = {"schema": 1, "status": "not_reproduced", "scope": context, "policy": config,
                 "initial": {"path": str(original), "sha256": hashed(original)}, "filenames": files, "reruns": []}
        for file in files:
            expected = {row["test"]: row["outcome"] for row in rows if row["file"] == file}
            for attempt in range(1, config["attempts"] + 1):
                value = sample(path.parent / ("rerun-" + uuid.uuid4().hex), receipt, config, file, attempt)
                proof["reruns"].append(value)
                checked_sample(path.parent, value, context, config, file, attempt, expected)
        scope(receipt)
        return proof
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        stop()
        return None


def verify(path, receipt):
    """Recheck immutable evidence. A malformed supplied proof is an error."""
    if KEY not in receipt:
        return False
    try:
        path, proof, config = Path(path).resolve(), receipt[KEY], policy()
        if not config or proof["schema"] != 1 or proof["status"] != "not_reproduced" or proof["policy"] != config:
            raise ValueError("retry proof or policy is invalid")
        original = confined(path.parent, proof["initial"]["path"])
        if original.name != "initial.json" or original.parent != path.parent or hashed(original) != proof["initial"]["sha256"]:
            raise ValueError("initial snapshot changed")
        raw = json.loads(original.read_text())
        final = {**receipt, "passed": False}
        final.pop(KEY)
        if raw != final:
            raise ValueError("original gate checks or results changed")
        context, rows, files = initial(path, raw)
        if proof["scope"] != context or proof["filenames"] != files:
            raise ValueError("retry scope or failed-file set changed")
        samples = proof["reruns"]
        if not isinstance(samples, list) or len(samples) != len(files) * config["attempts"]:
            raise ValueError("retry samples are incomplete")
        seen = set()
        for index, file in enumerate(files):
            expected = {row["test"]: row["outcome"] for row in rows if row["file"] == file}
            for attempt in range(1, config["attempts"] + 1):
                value = samples[index * config["attempts"] + attempt - 1]
                checked_sample(path.parent, value, context, config, file, attempt, expected)
                name = str(Path(value["directory"]).resolve())
                if name in seen:
                    raise ValueError("two samples reuse one report directory")
                seen.add(name)
        return True
    except (OSError, KeyError, TypeError, subprocess.SubprocessError) as error:
        raise ValueError("invalid retry evidence: " + str(error)) from error
