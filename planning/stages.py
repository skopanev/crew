"""Shared Medulla nodes and post hooks for planning-joppa."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess

from common import digest, fingerprint, inside, read, require, run, signal, write
from contracts import ROLES, load_contract
import drift
import validation
from responses import body_result
from tools import indexed_projects, prepare_opencode, prepare_critic, prepare_agy


def artifacts():
    return Path(os.environ["MEDULLA_RUN_DIR"]) / "artifacts"


def emit_var(name, value):
    value = json.dumps(value, ensure_ascii=False, separators=(",", ":")) if not isinstance(value, str) else value
    require(len(value.encode()) < 100000, f"{name}: context too large; narrow the AC")
    require("</signal:var>" not in value, "reserved signal delimiter in context")
    print(f"<signal:var key={name}>{value}</signal:var>")


def prepare_context(assignment, projects=None, read_paths=(), mcp_servers=None):
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
            f"{level}: {assignment[level]['text']}" for level in ("domain", "capability", "requirement", "ac")), "--json"], timeout=120))
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
    prepare_opencode([r["path"] for r in assignment["repositories"]] +
                     list(read_paths) + [os.environ["MEDULLA_RUN_DIR"]], mcp_servers=mcp_servers)
    signal("PREPARED", "Input, code versions, CBM and three Equill contracts recorded")


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
        bind_necessity(result)
        write(target / "plan.json", result)
        signal("PLANNED", "Structured implementation plan validated")
    elif kind == "necessity":
        save_necessity(result)
        signal("NEEDS_HUMAN" if result["owner_gaps"] else "ASSESSED", "Necessity assessment validated")
    elif kind in ("critic", "drift"):
        # A drift review uses the critic seats; only the bound digest and the verdict shape differ.
        seat = json.loads(os.environ["MEDULLA_INPUT"])
        require(os.environ["MEDULLA_HARNESS"] == seat["harness"], "critic harness differs from its assigned seat")
        if kind == "critic":
            expected = digest(read(target / "plan.json"))
            require(os.environ.get("PLANNING_REVIEW_DIGEST") == expected, "critic reviewed a different plan")
            result["plan_digest"] = expected
        else:
            expected = read(target / "drift.json")["digest"]
            require(os.environ.get("PLANNING_DRIFT_DIGEST") == expected, "critic reviewed a different drift")
            result["drift_digest"] = expected
        result["reviewer"] = {"harness": seat["harness"], "model": seat["model"]}
        (validation.critique if kind == "critic" else validation.drift)(result, expected)
        write(target / f"{kind}-{seat['slug']}.json", result)

def save_necessity(result):
    target = artifacts()
    expected = assessment_digest()
    require(os.environ.get("PLANNING_ASSESSMENT_DIGEST") == expected,
            "input or research changed during necessity assessment")
    result.setdefault("input_digest", expected)
    validation.necessity(result, expected, read(target / "input.json"))
    write(target / "necessity.json", result)
    emit_var("necessity", result)


def research_join():
    target = artifacts()
    reports = {key: read(target / f"research-{key}.json") for key in validation.RESEARCH}
    for key, report in reports.items():
        validation.research(report, key)
        require(report["status"] != "blocked", f"{key} research blocked: {report['summary']}")
    emit_var("research", reports)
    emit_var("assessment_digest", assessment_digest())
    signal("RESEARCHED", "All research branches completed")


def assessment_digest():
    target = artifacts()
    reports = {key: read(target / f"research-{key}.json") for key in validation.RESEARCH}
    for key, report in reports.items():
        validation.research(report, key)
    return digest({"assignment": read(target / "input.json"), "research": reports})


def require_necessity(plan=None, *, allow_owner_gaps=False):
    result = read(artifacts() / "necessity.json")
    validation.necessity(result, assessment_digest(), read(artifacts() / "input.json"))
    require(allow_owner_gaps or not result["owner_gaps"], "a required owner decision prevents design")
    if plan is not None:
        require(plan.get("necessity_digest") == digest(result), "plan uses a different necessity assessment")
    return result


def bind_necessity(plan):
    result = require_necessity()
    plan.setdefault("necessity_digest", digest(result))
    require_necessity(plan)


def review_input():
    plan = read(artifacts() / "plan.json")
    require(plan["disposition"] != "blocked", "plan blocked: " + "; ".join(plan["blockers"]))
    emit_var("plan", plan)
    emit_var("plan_digest", digest(plan))
    signal("REVIEW", "Frozen plan sent independently to two critics")


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


def verify_context(assignment, plan, review=True, *, mechanisms_only=False):
    target = artifacts()
    require_necessity(plan)
    reviews = {key: read(target / f"critic-{key}.json") for key in validation.CRITICS}
    for key, critic_review in reviews.items():
        validation.critique(critic_review, digest(plan))
        require(critic_review["verdict"] == "clear", f"{key} critic rejected: {critic_review['summary']}")
    old, contracts = verify_mechanism_context(assignment, plan) if mechanisms_only else verify_freshness(assignment, review)
    return reviews, old, contracts


def verify_mechanism_context(assignment, plan):
    """Recheck roles and current source without binding mechanism Tasks to a Git commit."""
    contracts = read(artifacts() / "contracts.json")
    with ThreadPoolExecutor(max_workers=3) as pool:
        loaded = dict(zip(ROLES, pool.map(lambda role: load_contract(role, assignment["workspace"]), ROLES)))
    require(all(loaded[k]["bundle_digest"] == contracts[k]["bundle_digest"] for k in ROLES),
            "mandatory Equill contract changed during planning; re-plan")
    prepared = read(artifacts() / "snapshots.json")
    current = {repo["id"]: fingerprint(repo) for repo in assignment["repositories"]}
    repositories = {repo["id"]: repo for repo in assignment["repositories"]}
    for key, repo in repositories.items():
        require(drift.clean(prepared[key]) and drift.clean(current[key]),
                "uncommitted source changes prevent planning publication")
        ancestor = subprocess.run(["git", "-C", repo["path"], "merge-base", "--is-ancestor",
                                   prepared[key]["head"], current[key]["head"]], capture_output=True, timeout=45)
        require(ancestor.returncode == 0, f"{key}: source no longer descends from the prepared base")
    directories = [(check["repository"], check["cwd"]) for check in plan["acceptance_checks"] if "cwd" in check]
    for task in plan["tasks"]:
        repo = repositories[task["repository"]]
        module = next(module for module in repo["modules"] if module["name"] == task["module"])
        directories.append((repo["id"], module["path"]))
        directories.extend((repo["id"], check["cwd"]) for check in task["checks"] if "cwd" in check)
    for key, directory in directories:
        require(inside(repositories[key]["path"], directory).is_dir(),
                f"{key}: planned working directory is absent: {directory}")
    return current, contracts


# The exact failure when the source moved while planning ran.
CODE_DRIFT = "source changed during planning; re-plan against current code"


class DriftReview(Exception):
    """finish stops before publication and sends the landed diff to the critics."""


def verify_freshness(assignment, review=True):
    """Source and role contracts are unchanged since prepare. Every published verdict needs this.

    With review, a clean fast-forward of the base gets one critic review of the
    diff per run (drift_review). Publication then uses the new base only if every
    critic clears it; any other change, or a second move, is CODE_DRIFT. This is
    the last check before publication, not an atomic part of it.
    """
    target = artifacts()
    old = read(target / "snapshots.json")
    sources = lambda: {r["id"]: fingerprint(r) for r in assignment["repositories"]}
    current = sources()
    # A requested review binds this run to its new base, even if the source returns to the old one.
    drifted = current != old or (target / "drift.json").is_file()
    require(review or not drifted, CODE_DRIFT)
    review = reviewed_base(assignment, old, current) if drifted else None
    contracts = read(target / "contracts.json")
    with ThreadPoolExecutor(max_workers=3) as pool:
        loaded = dict(zip(ROLES, pool.map(lambda role: load_contract(role, assignment["workspace"]), ROLES)))
    require(all(loaded[k]["bundle_digest"] == contracts[k]["bundle_digest"] for k in ROLES),
            "mandatory Equill contract changed during planning; re-plan")
    # The source can move while contracts load; judge only the base read above.
    require(sources() == current, CODE_DRIFT)
    if review is None:
        return old, contracts
    if review.get("outcome") == "cleared":
        write(target / "drift.json", review)
        return current, contracts
    request_review(review)


def reviewed_base(assignment, old, current):
    """The cleared record, a new review request, or CODE_DRIFT. Writes nothing on success."""
    target = artifacts()
    plan = read(target / "plan.json")
    file = target / "drift.json"
    if file.is_file():
        record = read(file)
        try:
            require("digest" in record, record.get("outcome", "no drift review"))
            # The new base must still be clean and identical to the reviewed one.
            require(all(drift.clean(current[k]) for k in record["repositories"]),
                    "uncommitted changes on the reviewed base")
            require(record["new"] == current, "source moved again during the drift review")
            require(record["old"] == old and record["plan_digest"] == digest(plan), "drift review covers another plan")
            return {**record, "verdicts": drift.verdicts(record, target, plan), "outcome": "cleared"}
        except Exception as error:
            write(target / "drift.json", {**record, "outcome": f"code_drift: {error}"})
            raise ValueError(CODE_DRIFT) from error
    try:
        record, diff = drift.prepare(assignment, plan, target, old, current)
    except Exception as error:
        write(target / "drift.json", {"old": old, "new": current, "outcome": f"code_drift without review: {error}"})
        raise ValueError(CODE_DRIFT) from error
    return {**record, "diff": diff}


def request_review(review):
    target = artifacts()
    diff = review.pop("diff")
    (target / "drift.diff").write_text(diff)
    write(target / "drift.json", {**review, "outcome": "review"})
    emit_var("drift", review)
    emit_var("drift_diff", diff)
    emit_var("drift_digest", review["digest"])
    raise DriftReview("Base advanced cleanly; critics review the landed diff before publication")


def capture_error_file(kind):
    branch = "design" if kind == "plan" else "necessity" if kind == "necessity" else json.loads(os.environ["MEDULLA_INPUT"])["slug"]
    require(branch in (*validation.RESEARCH, *validation.DRIFT_CRITICS, "design"), "unknown capture branch")
    return artifacts() / f"error-{kind}-{branch}.json"

