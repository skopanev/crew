"""Deterministic Medulla nodes and post hooks for planning."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import sys

from common import digest, fingerprint, read, require, run, signal, validate_input, write
from contracts import ROLES, load_contract
import validation
from freshness import snapshot, hydrate, utc_now
from responses import final_response


def artifacts():
    return Path(os.environ["MEDULLA_RUN_DIR"]) / "artifacts"


def emit_var(name, value):
    value = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
    require(len(value.encode()) < 100000, f"{name}: context too large; narrow the AC")
    require("</signal:var>" not in value, "reserved signal delimiter in context")
    print(f"<signal:var key={name}>{value}</signal:var>")


def prepare():
    target = artifacts()
    target.mkdir(parents=True, exist_ok=True)
    original = validate_input(read(os.environ["PLANNING_INPUT"]))
    write(target / "input-source.json", original)
    chain = snapshot(original["workspace"], original["requirement"]["id"], original["ac"]["id"])
    assignment = hydrate(original, chain)
    write(target / "joppa-snapshot.json", chain)
    write(target / "input.json", assignment)
    snapshots = {r["id"]: fingerprint(r) for r in assignment["repositories"]}
    write(target / "snapshots.json", snapshots)
    # Probe the configured index without indexing or starting a watcher.
    rows, offset = [], 0
    while True:
        projects = json.loads(run([os.environ["CBM_BIN"], "cli", "--json", "list_projects",
                                  "--format", "json", "--offset", str(offset)]))
        rows.extend(projects if isinstance(projects, list) else projects.get("projects", []))
        if isinstance(projects, list) or not projects.get("has_more"):
            break
        next_offset = projects.get("next_offset")
        require(type(next_offset) is int and next_offset > offset, "CBM pagination did not advance")
        offset = next_offset
    write(target / "cbm-projects.json", rows)
    names = {p["name"] for p in rows}
    require(all(r["cbm_project"] in names for r in assignment["repositories"]), "a requested repository is absent from the CBM index")
    with ThreadPoolExecutor(max_workers=3) as pool:
        contracts = dict(zip(ROLES, pool.map(lambda role: load_contract(role, assignment["workspace"]), ROLES)))
    write(target / "contracts.json", contracts)
    history = {r["id"]: run(["git", "-C", r["path"], "log", "-20", "--format=%h %s"]) for r in assignment["repositories"]}
    write(target / "history.json", history)
    knowledge = json.loads(run([os.environ["EQUILL_BIN"], "context", "--store", os.environ["EQUILL_STORE"],
        "--profile", "agent.memory.hybrid", "--role", "planning", "--project", assignment["workspace"],
        "--query", "\n".join(f"{level}: {assignment[level]['text']}"
                              for level in ("domain", "capability", "requirement", "ac")), "--json"]))
    require(knowledge.get("ok") is True, "Equill knowledge retrieval failed")
    write(target / "knowledge.json", knowledge)
    emit_var("assignment", assignment)
    emit_var("source_history", history)
    emit_var("knowledge", knowledge.get("content", ""))
    for role, contract in contracts.items():
        emit_var(role + "_contract", contract["content"])
    # Values become TOML scalars inside Codex's explicit per-run configuration.
    for name in ("CBM_BIN", "CBM_CACHE_DIR", "CBM_ALLOWED_ROOT"):
        emit_var(name + "_TOML", json.dumps(os.environ[name]))
    signal("PREPARED", "Input, code versions, CBM and three Equill contracts recorded")


def body_result():
    require(os.environ.get("MEDULLA_BODY_RC") == "0", "agent did not complete successfully")
    events = []
    for line in Path(os.environ["MEDULLA_ATTEMPT_LOG"]).read_text().splitlines():
        if line.startswith("[out] "):
            line = line[6:]
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict):
            events.append(event)
    result = final_response(events, os.environ["MEDULLA_HARNESS"])
    return result, events


def capture(kind):
    # Separate files avoid concurrent pool failures overwriting each other.
    error_file = capture_error_file(kind)
    error_file.unlink(missing_ok=True)
    result, events = body_result()
    target = artifacts()
    if kind == "research":
        branch = json.loads(os.environ["MEDULLA_INPUT"])["slug"]
        validation.research(result, branch)
        if branch == "code" and result["status"] == "complete":
            calls = [e.get("item", {}) for e in events if e.get("type") == "item.completed"]
            successful = [c for c in calls if c.get("type") == "mcp_tool_call"
                    and c.get("server") == "codebase-memory" and c.get("status") == "completed"
                    and not c.get("error") and not (c.get("result") or {}).get("isError")]
            used = {c.get("tool") for c in successful}
            similarity = any(c.get("tool") == "query_graph" and "SIMILAR_TO" in json.dumps(c.get("arguments", {})) for c in successful)
            require(bool(used & {"search_graph", "search_code"}) and similarity,
                    "code research has no successful CBM search and similarity-query receipts")
            validation.code_coverage(result, successful, read(target / "input.json"))
        write(target / f"research-{branch}.json", result)
    elif kind == "plan":
        validation.plan(result, read(target / "input.json"))
        write(target / "plan.json", result)
        signal("PLANNED", "Structured implementation plan validated")
    elif kind == "critic":
        seat = json.loads(os.environ["MEDULLA_INPUT"])
        slug = seat["slug"]
        require(os.environ["MEDULLA_HARNESS"] == seat["harness"], "critic harness differs from its assigned seat")
        validation.critique(result, digest(read(target / "plan.json")))
        result["reviewer"] = {"harness": seat["harness"], "model": seat["model"]}
        write(target / f"critic-{slug}.json", result)


def research_join():
    target = artifacts()
    reports = {key: read(target / f"research-{key}.json") for key in validation.RESEARCH}
    for key, report in reports.items():
        validation.research(report, key)
        require(report["status"] != "blocked", f"{key} research blocked: {report['summary']}")
    emit_var("research", reports)
    signal("RESEARCHED", "All research branches completed")


def review_input():
    plan = read(artifacts() / "plan.json")
    require(plan["disposition"] != "blocked", "plan blocked: " + "; ".join(plan["blockers"]))
    emit_var("plan", plan)
    emit_var("plan_digest", digest(plan))
    signal("REVIEW", "Frozen plan sent independently to three critics")


def finish():
    target = artifacts()
    assignment = read(target / "input.json")
    plan = read(target / "plan.json")
    validation.plan(plan, assignment)
    reviews = {key: read(target / f"critic-{key}.json") for key in validation.CRITICS}
    for key, review in reviews.items():
        validation.critique(review, digest(plan))
        require(review["verdict"] == "clear", f"{key} critic rejected: {review['summary']}")
    old = read(target / "snapshots.json")
    require(old == {r["id"]: fingerprint(r) for r in assignment["repositories"]}, "source changed during planning; re-plan against current code")
    require(digest(read(os.environ["PLANNING_INPUT"])) == digest(read(target / "input-source.json")), "input changed during planning")
    contracts = read(target / "contracts.json")
    with ThreadPoolExecutor(max_workers=3) as pool:
        current = dict(zip(ROLES, pool.map(lambda role: load_contract(role, assignment["workspace"]), ROLES)))
    require(all(current[k]["bundle_digest"] == contracts[k]["bundle_digest"] for k in ROLES),
            "mandatory Equill contract changed during planning; re-plan")
    chain = read(target / "joppa-snapshot.json")
    require(chain == snapshot(chain["workspace"], chain["requirement"]["id"], chain["ac"]["id"]),
            "Joppa Domain/Capability/Requirement/AC changed during planning; re-plan")
    # Admission is a local receipt, not a Joppa AC pass or owner acceptance.
    outcome = {"status": "ready" if plan["disposition"] == "implement" else "verify_existing",
               "scope": "local_plan", "joppa_currentness_verified": True,
               "joppa_snapshot": chain,
               "domain": assignment["domain"], "capability": assignment["capability"],
               "requirement": assignment["requirement"], "ac": assignment["ac"],
               "input_digest": digest(assignment), "plan_digest": digest(plan), "snapshots": old,
               "contracts": {k: {n: v[n] for n in ("role", "record_ids", "bundle_digest")}
                             for k, v in contracts.items()},
               "plan": plan, "reviews": reviews, "joppa_updated": False}
    lines = ["# Implementation plan", "", "Status: " + outcome["status"], "", plan["outcome"], "", "## Approach", "", plan["approach"], "", plan["rationale"]]
    for task in plan["tasks"]:
        lines += ["", "## " + task["id"] + ": " + task["title"], "", f"Repository: {task['repository']} · module: {task['module']}", "", task["outcome"], ""]
        lines += ["Prerequisite Tasks: " + (", ".join(task["depends_on"]) or "none"),
                  "Write paths: " + ", ".join(task["write_paths"]),
                  "Reuse: " + ("; ".join(task["reuse"]) or "none identified"), ""]
        lines += [f"{i}. {step}" for i, step in enumerate(task["steps"], 1)]
        lines += ["", "Checks:", ""] + [f"- `{c['command']}` in `{c['cwd']}`: {c['expected']}" for c in task["checks"]]
    (target / "plan.md").write_text("\n".join(lines) + "\n")
    outcome["completed_at"] = utc_now().isoformat()
    write(target / "result.json", outcome)
    signal("READY", target / "result.json")


def fail(reason=None):
    reason = reason or os.environ.get("MEDULLA_LAST_MESSAGE") or "workflow stopped without a valid result"
    errors = [read(path) for path in sorted(artifacts().glob("error-*.json"))]
    if errors:
        reason += "; " + "; ".join(f"{e['stage']}/{e['branch']}: {e['reason']}" for e in errors)
    write(artifacts() / "result.json", {"status": "blocked", "reason": reason,
                                       "errors": errors, "scope": "local_plan",
                                       "joppa_currentness_verified": False, "joppa_updated": False})
    signal("BLOCKED", reason)


def capture_error_file(kind):
    branch = "design" if kind == "plan" else json.loads(os.environ["MEDULLA_INPUT"])["slug"]
    require(branch in (*validation.RESEARCH, *validation.CRITICS, "design"), "unknown capture branch")
    return artifacts() / f"error-{kind}-{branch}.json"


if __name__ == "__main__":
    command = sys.argv[1]
    try:
        if command == "capture":
            capture(sys.argv[2])
        else:
            {"prepare": prepare, "research_join": research_join, "review_input": review_input,
             "finish": finish, "fail": fail}[command]()
    except Exception as exc:
        print(f"planning/{command}: {exc}", file=sys.stderr)
        if command == "capture":
            path = capture_error_file(sys.argv[2])
            write(path, {"stage": sys.argv[2], "branch": path.stem.split("-")[-1], "reason": str(exc)})
        else:
            fail(str(exc))
        sys.exit(1)
