"""Validate deliverables before any readiness decision can be emitted."""
from pathlib import Path
import json
import re

from common import inside, require, strings, text

RESEARCH = ("code", "knowledge", "external")
CRITICS = ("necessity", "simplicity", "correctness")


def evidence(items, name, empty=False):
    require(isinstance(items, list) and (empty or items), f"{name}: evidence required")
    for item in items:
        text(item.get("source"), "evidence.source")
        text(item.get("finding"), "evidence.finding")


def research(report, branch):
    require(report.get("status") in ("complete", "blocked", "not_needed"), "invalid research status")
    require(report["status"] != "not_needed" or branch == "external", "mandatory research cannot be skipped")
    text(report.get("summary"), "research.summary")
    strings(report.get("blockers"), "research.blockers", empty=True)
    evidence(report.get("evidence"), "research", empty=report["status"] != "complete")
    require(not report["blockers"] or report["status"] == "blocked", "research blockers cannot accompany success")
    if branch == "external" and report["status"] == "complete":
        require(any(e["source"].startswith("https://") for e in report["evidence"]), "external research must cite at least one HTTPS primary source")


def code_coverage(report, calls, assignment):
    """Require tool evidence for inspected paths, not inferred index freshness.

    CBM metadata is best-effort and describes its own indexed root. It does not
    prove completeness or equality with our worktree; source verification stays
    mandatory even when these checks pass.
    """
    inspected = report.get("inspected_paths")
    require(isinstance(inspected, list) and inspected, "code research needs inspected_paths")
    repos = {r["id"]: r for r in assignment["repositories"]}
    covered = set()
    for call in calls:
        if call.get("tool") != "check_index_coverage":
            continue
        reply = call.get("result", {})
        if "structuredContent" in reply:
            reply = reply["structuredContent"]
        elif "content" in reply:
            messages = [c["text"] for c in reply["content"] if c.get("type") == "text"]
            if len(messages) != 1:
                continue
            try:
                reply = json.loads(messages[0])
            except ValueError:
                continue
        if not isinstance(reply, dict):
            continue
        project = call.get("arguments", {}).get("project")
        if reply.get("project") != project:
            continue
        meta = reply.get("metadata", {})
        if not (meta.get("generation_matches") is True and meta.get("hash_records_complete") is True
                and meta.get("recording_status") == "complete"):
            continue
        for path in reply.get("paths", []):
            if (path.get("status") == "no_recorded_issue" and path.get("freshness") == "metadata_match"
                    and not path.get("coverage")):
                covered.add((project, path.get("path")))
            elif (path.get("status") == "partial" and path.get("freshness") == "metadata_match"
                    and isinstance(path.get("coverage"), list) and path["coverage"]
                    and all(isinstance(issue, dict) and issue.get("kind") == "parse_partial"
                            for issue in path["coverage"])):
                # Fresh parser gaps require source verification, not another index pass.
                covered.add((project, path.get("path")))
            elif path.get("freshness") == "not_tracked":
                # CBM does not index this file at all (for example helper scripts).
                # Nothing can be stale; the researcher read it in the worktree.
                covered.add((project, path.get("path")))
    seen, inspected_keys = set(), set()
    for item in inspected:
        repo = repos.get(item.get("repository"))
        require(repo is not None, "inspected path repository not in input")
        path = item.get("path")
        inside(repo["path"], path)
        require((repo["cbm_project"], path) in covered,
                f"CBM coverage missing, stale or uncertain for {repo['id']}:{path}; verify index and re-plan")
        seen.add(repo["id"])
        inspected_keys.add((repo["id"], path))
    if assignment.get("kind") == "ntk":
        module = assignment["ticket"].get("module")
        owners = {r["id"] for r in repos.values() if any(m["name"] == module for m in r["modules"])} if module else set()
        require(owners.issubset(seen), "code research must inspect the ticket module repository")
    else:
        require(seen == set(repos), "code research must inspect every repository in the AC scope")
    cited = set()
    for evidence in report["evidence"]:
        source = evidence["source"]
        for repository in repos:
            prefix = repository + ":"
            if source.startswith(prefix):
                match = re.fullmatch(r"(.+):[1-9][0-9]*(?:-[1-9][0-9]*)?", source[len(prefix):])
                require(match is not None, "code file evidence must use repository:path:line")
                cited.add((repository, match.group(1)))
    require(cited, "code research needs file evidence using registered repository:path:line")
    require(cited.issubset(inspected_keys), "code evidence cites a path absent from inspected_paths")
    for key in seen:
        repo = repos[key]
        scoped = [c for c in calls if c.get("arguments", {}).get("project") == repo["cbm_project"]]
        require(any(c.get("tool") in ("search_graph", "search_code") for c in scoped)
                and any(c.get("tool") == "query_graph" and "SIMILAR_TO" in json.dumps(c.get("arguments", {})) for c in scoped),
                f"CBM search and similarity-query receipts missing for {repo['id']}")


def plan(result, assignment):
    require(result.get("disposition") in ("implement", "verify_existing", "blocked"), "invalid plan disposition")
    for key in ("outcome", "necessity", "approach", "rationale"):
        text(result.get(key), "plan." + key)
    strings(result.get("alternatives"), "plan.alternatives")
    strings(result.get("blockers"), "plan.blockers", empty=True)
    checks(result.get("acceptance_checks"))
    tasks = result.get("tasks")
    require(isinstance(tasks, list), "plan.tasks must be a list")
    if result["disposition"] == "blocked":
        require(result["blockers"], "blocked plan needs a reason")
        return
    require(not result["blockers"], "blocked plan cannot proceed")
    require(bool(tasks) == (result["disposition"] == "implement"), "implementation needs Tasks; existing behavior must not create Tasks")
    repos = {r["id"]: r for r in assignment["repositories"]}
    seen = set()
    for task in tasks:
        key = text(task.get("id"), "task.id")
        require(key not in seen, f"duplicate Task: {key}")
        require(task.get("ac") == assignment["ac"]["id"], "Task must belong to the input AC")
        repo = repos.get(task.get("repository"))
        require(repo is not None, "Task repository not in input scope")
        module = next((m for m in repo["modules"] if m["name"] == task.get("module")), None)
        require(module is not None, "Task module not in input registry")
        root = inside(repo["path"], module["path"])
        for path in strings(task.get("write_paths", []), "task.write_paths", empty=True):
            require(inside(repo["path"], path).is_relative_to(root), f"Task path outside module: {path}")
        for field in ("title", "outcome"):
            text(task.get(field), "task." + field)
        strings(task.get("steps"), "task.steps")
        strings(task.get("reuse"), "task.reuse", empty=True)
        dependencies = strings(task.get("depends_on"), "task.depends_on", empty=True)
        require(set(dependencies).issubset(seen), "Tasks must be topologically ordered; unknown/cyclic prerequisite")
        checks(task.get("checks"))
        seen.add(key)
    for check in result["acceptance_checks"]:
        repo = repos.get(check.get("repository"))
        require(repo is not None, "acceptance check repository not in input scope")
        if "cwd" in check:
            inside(repo["path"], check["cwd"])
    for task in tasks:
        for check in task["checks"]:
            if "cwd" in check:
                inside(repos[task["repository"]]["path"], check["cwd"])


def checks(items):
    require(isinstance(items, list) and items, "observable acceptance checks required")
    for check in items:
        require(isinstance(check, dict), "check must be an object")
        text(check.get("expected"), "check.expected")
        if "scenario" in check:
            text(check["scenario"], "check.scenario")
        else:
            text(check.get("command"), "check.command")
        if "command" in check:
            text(check["command"], "check.command")
            text(check.get("cwd"), "check.cwd")


def critique(result, expected_digest):
    # Bind this verdict to the plan, including after a retry. Matching a digest
    # rejects stale artifacts; it cannot prove that an LLM understood the plan.
    require(result.get("plan_digest") == expected_digest, "critic reviewed a different plan")
    require(result.get("verdict") in ("clear", "reject"), "invalid critic verdict")
    text(result.get("summary"), "critic.summary")
    blocking = findings(result.get("findings"))
    require(blocking == (result["verdict"] == "reject"), "critic verdict and blocking findings disagree")


def findings(items):
    """Validate critic findings; True when any of them blocks."""
    require(isinstance(items, list), "critic.findings must be a list")
    for finding in items:
        for field in ("claim", "evidence", "resolution"):
            text(finding.get(field), "finding." + field)
        require(type(finding.get("blocking")) is bool, "finding.blocking must be boolean")
    return any(f["blocking"] for f in items)


DRIFT_QUESTIONS = ("cited_paths", "reused_units", "build_contracts", "absence_claims")


def drift(result, expected_digest):
    # Strict shape only: a drift verdict allows publication on a new base, so
    # every question needs an explicit boolean and an evidence list. Whether the
    # evidence names something real is decided at finish (drift.grounded).
    require(set(result) == {"drift_digest", "verdict", "summary", "answers", "findings", "reviewer"},
            "drift verdict has missing or extra fields")
    require(result["drift_digest"] == expected_digest, "critic reviewed a different drift")
    require(result["verdict"] in ("clear", "affected"), "invalid drift verdict")
    text(result["summary"], "drift.summary")
    answers = result["answers"]
    require(isinstance(answers, dict) and set(answers) == set(DRIFT_QUESTIONS), "drift.answers needs every question")
    for key, answer in answers.items():
        require(isinstance(answer, dict) and set(answer) == {"affected", "evidence"}
                and type(answer["affected"]) is bool and isinstance(answer["evidence"], list),
                f"drift.answers.{key} needs affected and an evidence list")
        for item in answer["evidence"]:
            require(isinstance(item, dict) and set(item) == {"source", "reason"},
                    f"drift.answers.{key}.evidence needs source and reason")
            text(item["source"], "evidence.source")
            text(item["reason"], "evidence.reason")
    blocking = findings(result["findings"]) or any(a["affected"] for a in answers.values())
    require(blocking == (result["verdict"] == "affected"), "drift verdict and its answers disagree")
