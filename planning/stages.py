"""Deterministic Medulla nodes and post hooks for planning."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import sys

from common import digest, fingerprint, read, require, run, signal, validate_input, write
from contracts import ROLES, load_contract
import validation
from freshness import snapshot, hydrate, utc_now
from responses import final_response


def artifacts():
    return Path(os.environ["MEDULLA_RUN_DIR"]) / "artifacts"


def emit_var(name, value):
    value = json.dumps(value, ensure_ascii=False, separators=(",", ":")) if not isinstance(value, str) else value
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
    prepare_context(assignment)


def indexed_projects():
    """Read the shared index registry without starting an indexer."""
    rows, offset = [], 0
    while True:
        projects = json.loads(run([os.environ["CBM_BIN"], "cli", "--json", "list_projects",
                                  "--format", "json", "--offset", str(offset)]))
        if isinstance(projects, dict) and "content" in projects:
            require(not projects.get("isError"), "CBM registry query failed")
            projects = projects.get("structuredContent") or json.loads(next(
                block["text"] for block in projects["content"] if block.get("type") == "text"))
        rows.extend(projects if isinstance(projects, list) else projects.get("projects", []))
        if isinstance(projects, list) or not projects.get("has_more"):
            return rows
        next_offset = projects.get("next_offset")
        require(type(next_offset) is int and next_offset > offset, "CBM pagination did not advance")
        offset = next_offset


def prepare_context(assignment, projects=None, read_paths=()):
    target = artifacts()
    snapshots = {r["id"]: fingerprint(r) for r in assignment["repositories"]}
    write(target / "snapshots.json", snapshots)
    # Probe the configured index without indexing or starting a watcher.
    rows = indexed_projects() if projects is None else projects
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
        "--query", assignment.get("knowledge_query") or "\n".join(
            f"{level}: {assignment[level]['text']}" for level in ("domain", "capability", "requirement", "ac")), "--json"]))
    require(knowledge.get("ok") is True, "Equill knowledge retrieval failed")
    write(target / "knowledge.json", knowledge)
    emit_var("assignment", prompt_assignment(assignment))
    emit_var("source_history", history)
    emit_var("knowledge", knowledge.get("content", ""))
    for role, contract in contracts.items():
        emit_var(role + "_contract", contract["content"])
    # Values become TOML scalars inside Codex's explicit per-run configuration.
    for name in ("CBM_BIN", "CBM_CACHE_DIR", "CBM_ALLOWED_ROOT"):
        emit_var(name + "_TOML", json.dumps(os.environ[name]))
    prepare_opencode([r["path"] for r in assignment["repositories"]] +
                     list(read_paths) + [os.environ["MEDULLA_RUN_DIR"]])
    signal("PREPARED", "Input, code versions, CBM and three Equill contracts recorded")


def prompt_assignment(assignment):
    """Remove repeated NTK context without removing prerequisite evidence."""
    if assignment.get("kind") != "ntk":
        return assignment
    result = {key: value for key, value in assignment.items() if key != "knowledge_query"}
    result["ac"] = {key: value for key, value in assignment["ac"].items() if key != "text"}
    result["repositories"] = [{key: value for key, value in repo.items() if key != "modules"}
                              for repo in assignment["repositories"]]
    result["ntk"] = dict(assignment["ntk"])
    result["ntk"]["source"] = {key: value for key, value in assignment["ntk"]["source"].items() if key != "ticket"}
    names = {item["name"] for repo in assignment["repositories"] for item in repo["modules"]}
    result["ntk"]["meta"] = {**assignment["ntk"]["meta"],
        "modules": [item for item in assignment["ntk"]["meta"]["modules"] if item["name"] in names]}
    result["details_file"] = str(artifacts() / "input.json")
    return result


def prepare_opencode(read_paths):
    """Keep provider settings in a private native config. Exclude inherited MCP."""
    source_env = {**os.environ, "OPENCODE_DISABLE_PROJECT_CONFIG": "true"}
    command = [os.environ.get("OPENCODE_BIN", "opencode"), "--pure", "debug", "config"]
    def query(environment, phase):
        result = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=45)
        require(result.returncode == 0,
                f"OpenCode {phase} config query failed (exit {result.returncode}):\n"
                + (result.stderr.strip() or "OpenCode returned no error details on stderr"))
        return json.loads(result.stdout)
    source = query(source_env, "source")
    providers = source.get("provider", {})
    require(isinstance(providers, dict), "OpenCode provider configuration is invalid")
    root = Path(os.environ["OPENCODE_CONFIG_HOME"])
    require(root.is_dir(), "OpenCode runtime config directory is unavailable")
    directory = root / "opencode"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    file = directory / "opencode.json"
    external = {"*": "deny"}
    for value in read_paths:
        for candidate in (Path(value).expanduser().absolute(), Path(value).expanduser().resolve()):
            path = str(candidate)
            require(path != "/" and not any(char in path for char in "*?"), "OpenCode read path is too broad")
            external[path] = "allow"
            external[path.rstrip("/") + "/**"] = "allow"
    with os.fdopen(os.open(file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as stream:
        json.dump({"provider": providers, "permission": {"external_directory": external}}, stream)
    read_only = {key: "deny" for key in ("edit", "write", "patch", "bash")}
    isolated_env = {**os.environ, "XDG_CONFIG_HOME": str(root),
                    "OPENCODE_CONFIG_DIR": str(directory), "OPENCODE_CONFIG": "",
                    "OPENCODE_CONFIG_CONTENT": json.dumps({"permission": read_only}), "OPENCODE_DISABLE_PROJECT_CONFIG": "true"}
    isolated = query(isolated_env, "isolated")
    require(not isolated.get("mcp"), "OpenCode isolation failed: inherited MCP remains")
    require(isolated.get("provider", {}) == providers, "OpenCode isolation changed provider settings")
    permission = isolated.get("permission", {})
    require(permission.get("external_directory") == external and
            all(permission.get(key) == "deny" for key in read_only),
            "OpenCode isolation changed read-only permissions")
    return str(root)


def prepare_critic():
    if os.environ["MEDULLA_HARNESS"] == "agy":
        prepare_agy()


def prepare_agy():
    """Verify the native MCP inventory in a private broker profile."""
    root = Path(os.environ["AGY_PROFILE_HOME"])
    require(root.is_dir(), "AGY runtime profile directory is unavailable")
    environment = {**os.environ, "BROKER_AGY_HOME": str(root), "BROKER_ISOLATE_MCP": "1"}
    result = subprocess.run([os.environ.get("AGY_BIN", "agy"), "mcp", "list"],
                            env=environment, capture_output=True, text=True, timeout=45)
    require(result.returncode == 0, f"AGY MCP query failed (exit {result.returncode})")
    require(result.stdout.strip() == "No MCP servers configured.",
            "AGY isolation failed: inherited MCP remains; update broker")
    config = root / ".gemini/config/mcp_config.json"
    require(config.parent.is_dir() and config.resolve().is_relative_to(root.resolve()),
            "AGY isolation failed: MCP configuration points outside the runtime profile; update broker")


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
        expected = digest(read(target / "plan.json"))
        require(os.environ.get("PLANNING_REVIEW_DIGEST") == expected, "critic reviewed a different plan")
        result["plan_digest"] = expected
        validation.critique(result, expected)
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


# One revision round: a second rejection is the verdict.
REVISIONS = 1


def critique_join():
    """Send blocking critic findings back to design once; otherwise go to finish."""
    target = artifacts()
    plan = read(target / "plan.json")
    reviews = {key: read(target / f"critic-{key}.json") for key in validation.CRITICS}
    for review in reviews.values():
        validation.critique(review, digest(plan))
    rejected = {key: [f for f in review["findings"] if f["blocking"]]
                for key, review in reviews.items() if review["verdict"] == "reject"}
    rounds = target / "revisions.json"
    done = read(rounds) if rounds.is_file() else []
    if not rejected or len(done) >= REVISIONS:
        signal("REVIEWED", "Critic verdicts sent to finish")
        return
    done.append({"plan_digest": digest(plan), "rejected": sorted(rejected)})
    write(rounds, done)
    emit_var("critique", {"previous_plan": plan, "blocking_findings": rejected})
    signal("REVISE", "Rejected by " + ", ".join(sorted(rejected)) + "; design revises once")


def finish():
    target = artifacts()
    assignment = read(target / "input.json")
    plan = read(target / "plan.json")
    validation.plan(plan, assignment)
    reviews, old, contracts = verify_context(assignment, plan)
    require(digest(read(os.environ["PLANNING_INPUT"])) == digest(read(target / "input-source.json")), "input changed during planning")
    chain = read(target / "joppa-snapshot.json")
    require(chain == snapshot(chain["workspace"], chain["requirement"]["id"], chain["ac"]["id"]),
            "Joppa Domain/Capability/Requirement/AC changed during planning; re-plan")
    save_result(assignment, plan, reviews, old, contracts, chain)


def verify_context(assignment, plan):
    target = artifacts()
    reviews = {key: read(target / f"critic-{key}.json") for key in validation.CRITICS}
    for key, review in reviews.items():
        validation.critique(review, digest(plan))
        require(review["verdict"] == "clear", f"{key} critic rejected: {review['summary']}")
    old, contracts = verify_freshness(assignment)
    return reviews, old, contracts


# The exact failure when the source moved while planning ran. planning-ntk marks
# it so its dispatcher can re-plan once against current code.
CODE_DRIFT = "source changed during planning; re-plan against current code"


def verify_freshness(assignment):
    """Source and role contracts are unchanged since prepare. Every published verdict needs this."""
    target = artifacts()
    old = read(target / "snapshots.json")
    require(old == {r["id"]: fingerprint(r) for r in assignment["repositories"]}, CODE_DRIFT)
    contracts = read(target / "contracts.json")
    with ThreadPoolExecutor(max_workers=3) as pool:
        current = dict(zip(ROLES, pool.map(lambda role: load_contract(role, assignment["workspace"]), ROLES)))
    require(all(current[k]["bundle_digest"] == contracts[k]["bundle_digest"] for k in ROLES),
            "mandatory Equill contract changed during planning; re-plan")
    return old, contracts


def save_result(assignment, plan, reviews, old, contracts, chain):
    target = artifacts()
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
                  "Reuse: " + ("; ".join(task["reuse"]) or "none identified"), ""]
        lines += [f"{i}. {step}" for i, step in enumerate(task["steps"], 1)]
        lines += ["", "Checks:", ""]
        for check in task["checks"]:
            method = check.get("scenario") or f"`{check['command']}` in `{check['cwd']}`"
            lines.append(f"- {method}: {check['expected']}")
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
            {"prepare": prepare, "prepare_critic": prepare_critic, "research_join": research_join, "review_input": review_input,
             "critique_join": critique_join, "finish": finish, "fail": fail}[command]()
    except Exception as exc:
        print(f"planning/{command}: {exc}", file=sys.stderr)
        if command in ("capture", "prepare_critic"):
            kind = sys.argv[2] if command == "capture" else "critic"
            path = capture_error_file(kind)
            write(path, {"stage": kind, "branch": path.stem.split("-")[-1], "reason": str(exc)})
        else:
            fail(str(exc))
        sys.exit(1)
