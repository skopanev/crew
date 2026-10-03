"""Small shared primitives for the planning workflow (stdlib only)."""
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def text(value, name):
    require(isinstance(value, str) and bool(value.strip()), f"{name}: nonempty string required")
    return value


def strings(value, name, empty=False):
    require(isinstance(value, list) and (empty or bool(value)), f"{name}: list required")
    for item in value:
        text(item, name)
    return value


def read(path):
    return json.loads(Path(path).read_text())


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temp.replace(path)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def run(argv, **kwargs):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=45, **kwargs)
    require(result.returncode == 0, f"{argv[0]} failed:\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")
    return result.stdout


def inside(root, relative):
    text(relative, "relative path")
    path = Path(relative)
    require(not path.is_absolute() and ".." not in path.parts, f"invalid relative path: {relative}")
    resolved = (Path(root) / path).resolve()
    require(resolved.is_relative_to(Path(root).resolve()), f"path escapes root: {relative}")
    return resolved


def validate_input(data):
    require(isinstance(data, dict), "input must be an object")
    text(data.get("workspace"), "workspace")
    for level in ("domain", "capability"):
        context = data.get(level)
        require(isinstance(context, dict), f"{level}: context object required")
        text(context.get("id"), f"{level}.id")
        text(context.get("text"), f"{level}.text")
    req = data.get("requirement", {})
    text(req.get("id"), "requirement.id")
    text(req.get("text"), "requirement.text")
    require(type(req.get("revision")) is int and req["revision"] > 0, "requirement.revision must be positive")
    text(data.get("ac", {}).get("id"), "ac.id")
    text(data["ac"].get("text"), "ac.text")
    strings(data.get("decisions", []), "decisions", empty=True)
    repos = data.get("repositories")
    require(isinstance(repos, list) and repos, "repositories required")
    ids = set()
    for repo in repos:
        key = text(repo.get("id"), "repository.id")
        require(key not in ids, f"duplicate repository: {key}")
        ids.add(key)
        root = Path(text(repo.get("path"), "repository.path"))
        require(root.is_absolute(), "repository paths must be absolute")
        text(repo.get("cbm_project"), "repository.cbm_project")
        modules = repo.get("modules")
        require(isinstance(modules, list) and modules, f"{key}: modules required")
        names = set()
        for module in modules:
            name = text(module.get("name"), "module.name")
            require(name not in names, f"duplicate module: {name}")
            names.add(name)
            inside(root, module.get("path"))
    return data


def fingerprint(repo):
    root = repo["path"]
    env = {**os.environ, "GIT_OPTIONAL_LOCKS": "0"}
    git = lambda *args: run(["git", "-C", root, *args], env=env)
    head = git("rev-parse", "HEAD").strip()
    status = git("status", "--porcelain=v1", "-z", "--untracked-files=all")
    # Binary diffs can be much larger than source; spool them with a bounded wait
    # rather than accumulating the entire subprocess output in Python memory.
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        proc = subprocess.run(["git", "-C", root, "diff", "--no-ext-diff", "--no-textconv",
                               "--binary", "HEAD", "--"], stdout=output, stderr=errors,
                              env=env, timeout=45)
        errors.seek(0)
        require(proc.returncode == 0, "git diff failed: " + errors.read().decode(errors="replace"))
        output.seek(0)
        changes = stream_digest(output)
    untracked = []
    for name in git("ls-files", "--others", "--exclude-standard", "-z").split("\0"):
        if not name:
            continue
        path = Path(root) / name
        before = path.lstat()
        if path.is_symlink():
            content_digest = hashlib.sha256(os.fsencode(os.readlink(path))).hexdigest()
        else:
            with path.open("rb") as file:
                content_digest = stream_digest(file)
        after = path.lstat()
        signature = lambda stat: (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
        require(signature(before) == signature(after), f"source changed while fingerprinting: {name}")
        untracked.append((name, content_digest))
    require(head == git("rev-parse", "HEAD").strip()
            and status == git("status", "--porcelain=v1", "-z", "--untracked-files=all"),
            "source changed while fingerprinting")
    return {"head": head, "worktree_digest": digest([head, status, changes, untracked])}


def stream_digest(file):
    result = hashlib.sha256()
    for chunk in iter(lambda: file.read(1024 * 1024), b""):
        result.update(chunk)
    return result.hexdigest()


def signal(name, message):
    # Do not allow text from an agent or exception to inject another routing tag.
    safe = str(message).replace("<", "[").replace(">", "]").replace("\n", " ")
    print(f"<signal:{name}>{safe}</signal:{name}>")
