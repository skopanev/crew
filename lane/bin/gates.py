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
import signal
import shlex
import subprocess
import sys
import time
import uuid


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def plan():
    commands = json.loads(os.environ.get("gate_commands", "[]"))
    if not isinstance(commands, list) or not commands or any(
        not isinstance(command, str) or not command.strip() for command in commands
    ):
        raise ValueError("no valid gate commands declared by the launcher")
    if os.environ.get("VERIFY_ONLY") == "true":
        tests = json.loads((Path(os.environ["MEDULLA_RUN_DIR"]) / "artifacts/ticket-checks.json").read_text())
        if not isinstance(tests, list) or not tests or any(
            not isinstance(command, str) or not command.strip() for command in tests
        ):
            raise ValueError("verification requires test-file paths in ticket-checks.json")
        runner = json.loads(os.environ.get("ticket_test_command", "[]"))
        if not isinstance(runner, list) or not runner or any(
            not isinstance(arg, str) or not arg.strip() for arg in runner
        ):
            raise ValueError("verification requires testCommand in dispatcher config")
        root = Path.cwd().resolve()
        paths = []
        for test in tests:
            path = Path(test)
            if path.is_absolute() or not path.is_file() or not path.resolve().is_relative_to(root):
                raise ValueError(f"test must be an existing file inside this checkout: {test}")
            paths.append("./" + str(path.resolve().relative_to(root)))
        commands = [shlex.join([*runner, *dict.fromkeys(paths)]), *commands]
    return commands


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
        with log.open("xb") as output:
            process = subprocess.Popen(["bash", "-euo", "pipefail", "-c", command],
                                       stdout=output, stderr=subprocess.STDOUT,
                                       start_new_session=True)
            try:
                rc = process.wait(timeout=900)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                timed_out, rc = True, 124
        receipt["checks"].append({"command": command, "cwd": who["cwd"],
                                  "exit_code": rc, "timed_out": timed_out,
                                  "started_at": started, "finished_at": time.time(),
                                  "log": str(log), "sha256": digest(log)})
        print(f"gate {index + 1}: rc={rc} log={log}", file=sys.stderr)
        if rc != 0:
            break
    receipt["passed"] = (len(receipt["checks"]) == len(commands)
                         and all(c["exit_code"] == 0 for c in receipt["checks"])
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
