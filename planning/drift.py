"""Review of a clean base advance under a finished plan, before publication.

The critics, not a path heuristic, decide whether the landed diff affects the
plan. This module only decides which drift is small and simple enough to show
them, binds their verdicts to that exact diff, and records the result.
"""
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile

from common import digest, read, require, run
import validation

# Larger diffs go back to a full re-plan: a reviewer cannot be trusted to read them.
DIFF_LIMIT = 60 * 1024
# Statuses that remove or replace a path. git diff -M reports renames as R<score>.
STRUCTURAL = ("D", "R", "T")
GIT_ENV = {**os.environ, "GIT_OPTIONAL_LOCKS": "0"}


def git(root, *args):
    return run(["git", "-C", root, *args], env=GIT_ENV)


def clean(snapshot):
    """True when fingerprint() recorded no status, diff or untracked file at HEAD."""
    empty = hashlib.sha256(b"").hexdigest()
    return snapshot["worktree_digest"] == digest([snapshot["head"], "", empty, []])


def changes(root, old, new):
    fields = git(root, "diff", "--no-ext-diff", "--no-textconv", "-M", "--name-status", "-z", old, new).split("\0")
    rows, index = [], 0
    while index < len(fields) - 1:
        status = fields[index]
        if status[0] in "RC":
            rows.append({"status": status, "from": fields[index + 1], "path": fields[index + 2]})
            index += 3
        else:
            rows.append({"status": status, "path": fields[index + 1]})
            index += 2
    return rows


def binaries(root, old, new):
    """Paths whose change git reports only as "Binary files ... differ" (numstat "-")."""
    fields, found, index = git(root, "diff", "--no-ext-diff", "--no-textconv", "-M", "--numstat", "-z", old, new).split("\0"), [], 0
    while index < len(fields) - 1:
        added, _, path = fields[index].split("\t", 2)
        if path:
            index += 1
        else:  # rename or copy: the old and new path follow as separate fields
            path, index = fields[index + 2], index + 3
        if added == "-":
            found.append(path)
    return found


def patch(root, old, new, budget):
    """The diff text, or None when it exceeds the budget. Spooled, never fully in memory."""
    with tempfile.TemporaryFile() as output:
        proc = subprocess.run(["git", "-C", root, "diff", "--no-ext-diff", "--no-textconv", "--no-color",
                               "-M", old, new], stdout=output, stderr=subprocess.PIPE, env=GIT_ENV, timeout=45)
        require(proc.returncode == 0, "git diff failed: " + proc.stderr.decode(errors="replace"))
        if output.tell() > budget:
            return None
        output.seek(0)
        return output.read().decode(errors="replace")


def cited(assignment, plan, target):
    """Per repository: path prefixes the plan or research depends on, and check directories."""
    repos = {r["id"]: r for r in assignment["repositories"]}
    paths = {key: set() for key in repos}
    # Module names are unique only within a repository.
    modules = {(r["id"], m["name"]): m["path"] for r in repos.values() for m in r["modules"]}
    named = [(t.get("repository"), t.get("module")) for t in plan.get("tasks", [])]
    ticket = assignment.get("ticket", {}).get("module")
    named += [(key, ticket) for key in repos if ticket]
    for key in named:
        if key in modules:
            paths[key[0]].add(modules[key])
    # A check directory is not a dependency on every file below it; it only has to survive.
    cwds = {key: set() for key in repos}
    checks = [(c, c.get("repository")) for c in plan.get("acceptance_checks", [])]
    for task in plan.get("tasks", []):
        paths.get(task.get("repository"), set()).update(task.get("write_paths", []))
        checks += [(c, task.get("repository")) for c in task.get("checks", [])]
    for check, repo in checks:
        if "cwd" in check and repo in cwds:
            cwds[repo].add(check["cwd"])
    for item in read(target / "research-code.json").get("inspected_paths", []):
        paths.get(item.get("repository"), set()).add(item.get("path"))
    normal = lambda value: {os.path.normpath(p) for p in value if isinstance(p, str)}
    return {key: normal(value) for key, value in paths.items()}, {key: normal(value) for key, value in cwds.items()}


def touches(path, paths, text):
    return path in text or any(c == "." or path == c or path.startswith(c + "/") or c.startswith(path + "/")
                               for c in paths)


def prepare(assignment, plan, target, old, current):
    """Build the review input for a clean fast-forward, or raise with the reason it is not eligible."""
    citations, cwds = cited(assignment, plan, target)
    # Names cited in prose (steps, reuse, evidence, absence claims) count as cited too.
    text = citations_text(plan, target)
    repos, budget = {}, DIFF_LIMIT
    for repo in assignment["repositories"]:
        before, after = old[repo["id"]], current[repo["id"]]
        if before == after:
            continue
        require(clean(before) and clean(after), f"{repo['id']}: uncommitted changes at prepare or now")
        root = repo["path"]
        ancestor = subprocess.run(["git", "-C", root, "merge-base", "--is-ancestor", before["head"], after["head"]],
                                  capture_output=True, timeout=45)
        require(ancestor.returncode == 0, f"{repo['id']}: HEAD did not advance from the planned base")
        rows = changes(root, before["head"], after["head"])
        for row in rows:
            for path in (row["path"], row.get("from")):
                require(not (path and row["status"][0] in STRUCTURAL and touches(path, citations[repo["id"]], text)),
                        f"{repo['id']}: {row['status']} {path} is cited by the plan or research")
        # A reviewer sees only the name of a binary change; it cannot clear its effect.
        opaque = binaries(root, before["head"], after["head"])
        require(not opaque, f"{repo['id']}: binary change {', '.join(opaque)}")
        for cwd in cwds[repo["id"]] - {"."}:
            require(subprocess.run(["git", "-C", root, "cat-file", "-e", f"{after['head']}:{cwd}"],
                                   capture_output=True, timeout=45).returncode == 0,
                    f"{repo['id']}: check directory {cwd} is gone")
        diff = patch(root, before["head"], after["head"], budget)
        require(diff is not None, f"diff exceeds {DIFF_LIMIT} bytes")
        require("</signal:var>" not in diff, f"{repo['id']}: diff contains a reserved signal delimiter")
        budget -= len(diff.encode())
        repos[repo["id"]] = {"old_head": before["head"], "new_head": after["head"], "changes": rows,
                             "diff_digest": hashlib.sha256(diff.encode()).hexdigest(), "diff": diff}
    record = {"plan_digest": digest(plan), "old": old, "new": current,
              "repositories": {k: {n: v for n, v in r.items() if n != "diff"} for k, r in repos.items()}}
    record["digest"] = digest(record)
    return record, "\n".join(f"### {key}\n{r['diff']}" for key, r in repos.items())


def citations_text(plan, target):
    return json.dumps([plan, *(read(target / f"research-{b}.json") for b in validation.RESEARCH)], ensure_ascii=False)


# Reasons that state a conclusion without saying what was compared.
GENERIC = re.compile(r"(?i)^\W*(un|not |no )?(affected|impact(ed)?|change[sd]?|relevant|related|applicable)?\W*"
                     r"(n/?a|none|ok|clear|fine|same|nothing|no issues?)?\W*$")


def grounded(result, record, text):
    """Every answer names a changed path or a plan/research citation and says why.

    A clear verdict needs evidence for each question; an empty, unnamed or
    generic entry means the critic did not show the check, so it is not clear.
    """
    changed = {p for r in record["repositories"].values() for c in r["changes"] for p in (c["path"], c.get("from")) if p}
    for key, answer in result["answers"].items():
        require(answer["evidence"], f"no evidence for {key}")
        for item in answer["evidence"]:
            source = re.sub(r":[1-9][0-9]*(?:-[1-9][0-9]*)?$", "", item["source"].strip())
            source = source.split(":", 1)[1] if source.split(":", 1)[0] in record["repositories"] else source
            require(source in changed or (len(source) >= 3 and source in text),
                    f"{key} evidence names neither a changed path nor a plan citation: {item['source']}")
            reason = item["reason"].strip()
            require(len(reason) >= 20 and not GENERIC.match(reason), f"{key} evidence reason is generic: {reason}")


def verdicts(record, target, plan):
    """Every critic seat cleared exactly this diff with grounded evidence. Raises with the reason otherwise."""
    results, text = {}, citations_text(plan, target)
    for key in validation.CRITICS:
        file = target / f"drift-{key}.json"
        require(file.is_file(), f"{key}: no drift verdict")
        result = read(file)
        validation.drift(result, record["digest"])
        require(result["verdict"] == "clear", f"{key}: diff affects the plan: {result['summary']}")
        grounded(result, record, text)
        results[key] = result
    return results


def cleared(target):
    """The audit record of a drift review that allowed publication, if any."""
    file = Path(target) / "drift.json"
    record = read(file) if file.is_file() else None
    return record if record and record.get("outcome") == "cleared" else None
