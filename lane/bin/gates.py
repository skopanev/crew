#!/usr/bin/env python3
"""Run declared checks and bind their receipts to the candidate Git tree.

These are local run artifacts, not a Joppa Attempt or an acceptance verdict.
The launcher supplies gate_commands as a JSON array; model prose is never proof.
"""

import hashlib
import json
import os
from pathlib import Path
import platform
import re
import signal
import shlex
import subprocess
import sys
import tempfile
import time
import uuid


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def acceptance_check(check):
    if (not isinstance(check, dict) or set(check) - {"ac", "argv", "stdout"}
            or not isinstance(check.get("ac"), str) or not check["ac"].strip()):
        raise ValueError("acceptance check requires ac, argv and optional stdout")
    argv = check.get("argv")
    if (not isinstance(argv, list) or not argv
            or any(not isinstance(arg, str) or "\0" in arg for arg in argv)
            or ("stdout" in check and not isinstance(check["stdout"], str))):
        raise ValueError("invalid acceptance check arguments or stdout")
    paths = []
    output_required = False
    if (len(argv) >= 5 and argv[:2] == ["git", "check-attr"]
            and re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]*", argv[2])
            and argv[3] == "--"):
        paths, output_required = argv[4:], True
    elif len(argv) >= 4 and argv[:3] == ["git", "ls-files", "--"]:
        paths, output_required = argv[3:], True
    elif len(argv) >= 5 and argv[:4] == ["git", "ls-files", "--error-unmatch", "--"]:
        paths = argv[4:]
    elif (len(argv) == 5 and argv[:3] == ["grep", "-Fq", "--"] and argv[3]
          and "\n" not in argv[3] and "\r" not in argv[3]):
        paths = argv[4:]
    elif len(argv) == 3 and argv[0] == "test" and argv[1] in {"-e", "-f", "-d", "-s"}:
        paths = argv[2:]
    if not paths or (output_required and "stdout" not in check):
        raise ValueError("unsupported acceptance check or missing exact stdout")
    root = Path.cwd().resolve()
    for value in paths:
        path = Path(value)
        if not value or path.is_absolute() or not path.resolve().is_relative_to(root):
            raise ValueError(f"check path must stay inside this checkout: {value}")
    return check


def plan():
    commands = json.loads(os.environ.get("gate_commands", "[]"))
    if not isinstance(commands, list) or not commands or any(
        not isinstance(command, str) or not command.strip() for command in commands
    ):
        raise ValueError("no valid gate commands declared by the launcher")
    if os.environ.get("VERIFY_ONLY") == "true":
        tests = json.loads((Path(os.environ["MEDULLA_RUN_DIR"]) / "artifacts/ticket-checks.json").read_text())
        if not isinstance(tests, list) or not tests:
            raise ValueError("verification requires checks in ticket-checks.json")
        root = Path.cwd().resolve()
        paths, checks = [], []
        for test in tests:
            if isinstance(test, dict):
                checks.append(acceptance_check(test))
                continue
            if not isinstance(test, str) or not test.strip():
                raise ValueError("verification requires test paths or acceptance checks")
            path = Path(test)
            if path.is_absolute() or not path.is_file() or not path.resolve().is_relative_to(root):
                raise ValueError(f"test must be an existing file inside this checkout: {test}")
            paths.append("./" + str(path.resolve().relative_to(root)))
        if paths:
            runner = json.loads(os.environ.get("ticket_test_command", "[]"))
            if not isinstance(runner, list) or not runner or any(
                not isinstance(arg, str) or not arg.strip() for arg in runner
            ):
                raise ValueError("verification requires testCommand in dispatcher config")
            checks.insert(0, shlex.join([*runner, *dict.fromkeys(paths)]))
        commands = [*checks, *commands]
    unique = []
    for command in commands:
        if command not in unique:
            unique.append(command)
    return unique


def identity():
    return {"task": os.environ["ticket_id"],
            "run": str(Path(os.environ["MEDULLA_RUN_DIR"]).resolve()),
            "repository": os.environ["project_dir"],
            "module": os.environ["module_name"],
            "cwd": str(Path.cwd().resolve())}


def unchanged(tree):
    return (git("write-tree") == tree
            and not git("diff", "--name-only")
            and not git("ls-files", "--others", "--exclude-standard"))


def run(root):
    # Invalidate the old pass before parsing the new plan or invoking any check.
    current = root / "current.json"
    current.unlink(missing_ok=True)
    commands = plan()
    who = identity()
    tree, base = git("write-tree"), git("rev-parse", "HEAD")
    if not unchanged(tree):
        raise ValueError("candidate has unstaged or untracked changes")
    # A real Git object identifies the staged candidate without moving HEAD.
    candidate = git("-c", "user.name=lane", "-c", "user.email=lane@local",
                    "commit-tree", tree, "-p", base, "-m", "Lane gate candidate")
    folder = root / uuid.uuid4().hex
    folder.mkdir()
    receipt = {"schema": 1, **who, "tree": tree, "base": base,
               "candidate_sha": candidate, "commands": commands,
               "toolchain": {"python": platform.python_version(),
                             "platform": platform.platform(),
                             "git": git("--version"),
                             "bash": subprocess.check_output(
                                 ["bash", "--version"], text=True).splitlines()[0]},
               "checks": [], "passed": False}
    for index, command in enumerate(commands):
        log = folder / f"{index + 1}.log"
        started = time.time()
        timed_out = False
        structured = isinstance(command, dict)
        stdout_matches = True
        argv = command["argv"] if structured else ["bash", "-euo", "pipefail", "-c", command]
        with log.open("xb") as output, tempfile.TemporaryFile() as errors:
            process = subprocess.Popen(argv,
                                       env={**os.environ, "GIT_LITERAL_PATHSPECS": "1"} if structured else None,
                                       stdout=output, stderr=errors if structured else subprocess.STDOUT,
                                       start_new_session=True)
            try:
                rc = process.wait(timeout=900)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                timed_out, rc = True, 124
            if structured:
                output.flush()
                if "stdout" in command:
                    stdout_matches = log.read_bytes() == command["stdout"].encode("utf-8")
                errors.seek(0)
                output.write(errors.read())
        receipt["checks"].append({"command": command, "cwd": who["cwd"],
                                  "exit_code": rc, "timed_out": timed_out,
                                  "stdout_matches": stdout_matches,
                                  "started_at": started, "finished_at": time.time(),
                                  "log": str(log), "sha256": digest(log)})
        print(f"gate {index + 1}: rc={rc} stdout_matches={stdout_matches} log={log}", file=sys.stderr)
        if rc != 0 or not stdout_matches:
            break
    receipt["passed"] = (len(receipt["checks"]) == len(commands)
                         and all(c["exit_code"] == 0 and c["stdout_matches"] for c in receipt["checks"])
                         and unchanged(tree) and git("rev-parse", "HEAD") == base)
    path = folder / "receipt.json"
    with path.open("x") as output:
        json.dump(receipt, output, indent=2)
        output.write("\n")
    print(path)
    if not receipt["passed"]:
        raise ValueError(f"checks failed or changed the candidate; receipt: {path}")
    temporary = root / "current.tmp"
    temporary.write_text(json.dumps({"receipt": str(path), "sha256": digest(path)}))
    temporary.replace(current)


def verify(root):
    pointer = json.loads((root / "current.json").read_text())
    path = Path(pointer["receipt"]).resolve()
    if not path.is_relative_to(root.resolve()) or digest(path) != pointer["sha256"]:
        raise ValueError("gate receipt is outside this run or has changed")
    receipt = json.loads(path.read_text())
    if not receipt["passed"] or receipt["commands"] != plan():
        raise ValueError("no passing receipt for the declared gate plan")
    if any(receipt.get(key) != value for key, value in identity().items()):
        raise ValueError("gate receipt belongs to another task, run, or repository scope")
    if not unchanged(receipt["tree"]):
        raise ValueError("candidate changed after gate execution")
    head = git("rev-parse", "HEAD")
    if head != receipt["base"] and (
        git("show", "-s", "--format=%P", "HEAD") != receipt["base"]
        or git("rev-parse", "HEAD^{tree}") != receipt["tree"]
    ):
        raise ValueError("candidate history changed after gate execution")
    if git("rev-parse", receipt["candidate_sha"] + "^{tree}") != receipt["tree"]:
        raise ValueError("candidate SHA does not identify the checked tree")
    if len(receipt["checks"]) != len(receipt["commands"]):
        raise ValueError("missing gate results")
    for command, check in zip(receipt["commands"], receipt["checks"]):
        log = Path(check["log"]).resolve()
        if (check["command"] != command or check["exit_code"] != 0
                or (isinstance(command, dict) and check.get("stdout_matches") is not True)
                or not log.is_relative_to(path.parent) or digest(log) != check["sha256"]):
            raise ValueError("gate result or log does not match the receipt")
    print(path)


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("run", "verify"):
        raise ValueError("usage: gates.py run|verify")
    root = Path(os.environ["MEDULLA_RUN_DIR"]).resolve() / "artifacts/gates"
    root.mkdir(parents=True, exist_ok=True)
    (run if sys.argv[1] == "run" else verify)(root)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(f"gate refused: {error}", file=sys.stderr)
        sys.exit(1)
