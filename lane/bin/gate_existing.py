"""Validate existing-code checks without running repository gates."""

import json
from pathlib import Path
import re
import shlex
import subprocess

import test_bindings


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def acceptance_check(check, root=None):
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
    if not paths:
        raise ValueError(f"unsupported acceptance check for {check['ac']!r}: {shlex.join(argv)}")
    if output_required and "stdout" not in check:
        raise ValueError(f"missing exact stdout for acceptance check {check['ac']!r}: {shlex.join(argv)}")
    root = Path(root or Path.cwd()).resolve()
    for value in paths:
        path = Path(value)
        if not value or path.is_absolute() or not (root / path).resolve().is_relative_to(root):
            raise ValueError(f"check path must stay inside this checkout: {value}")
    return check


def existing(root):
    """Select recorded Task tests only when their files and titles already exist at HEAD."""
    artifacts = root.parent
    ticket = json.loads((artifacts / "ticket.json").read_text())
    paths = []
    for task in ticket.get("tasks") or [ticket]:
        tests = task.get("acceptanceTests")
        if not isinstance(tests, list) or not tests:
            raise ValueError("every Task needs recorded acceptanceTests for existing-code verification")
        for test in tests:
            if (not isinstance(test, dict) or not isinstance(test.get("command"), str)
                    or not isinstance(test.get("title"), str) or not test["title"].strip()):
                raise ValueError("existing-code verification needs a Test command and title")
            reporters = re.findall(r"Reporter name:[ \t]*([^\r\n]+)", test.get("body", ""))
            if len(reporters) > 1 or reporters and " > " not in reporters[0]:
                raise ValueError("existing-code verification needs one unambiguous Reporter name")
            argv = shlex.split(test["command"])
            command_root = Path.cwd().resolve()
            if argv[:1] == ["cd"]:
                if len(argv) < 4 or argv[2] != "&&" or Path(argv[1]).is_absolute():
                    raise ValueError("existing-code verification supports only cd <directory> && <command>")
                command_root = (command_root / argv[1]).resolve()
                if not command_root.is_dir() or not command_root.is_relative_to(Path.cwd().resolve()):
                    raise ValueError("the Test command directory must stay inside this checkout")
                argv = argv[3:]
            parts = reporters[0].split(" > ") if reporters else []
            path = Path(parts[0].strip()) if len(parts) > 1 else command_root / argv[-1] if argv else Path()
            if not parts:
                path = path.relative_to(Path.cwd().resolve())
            title = parts[-1].strip() if len(parts) > 1 else test["title"]
            if (path.is_absolute() or not path.is_file()
                    or not path.resolve().is_relative_to(Path.cwd().resolve())):
                raise ValueError("the Test command must end with a file inside this checkout")
            name = path.as_posix()
            if parts and not any((command_root / arg).resolve() == path.resolve() for arg in argv):
                raise ValueError("Reporter file differs from the Test command")
            git("--literal-pathspecs", "ls-files", "--error-unmatch", "--", name)
            if not title or title not in git("show", f"HEAD:{name}"):
                raise ValueError(f"recorded Test name is absent at HEAD: {title}")
            if name not in paths:
                paths.append(name)
    if not paths:
        raise ValueError("existing-code verification needs Task test files")
    test_bindings.write(artifacts / "ticket-checks.json", paths)
    print(f"Verify existing code with {len(paths)} recorded Task test file(s).")


