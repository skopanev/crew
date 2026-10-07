"""NTK entry and publication stages for the shared planning graph."""
import json
import importlib.util
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
from launch import configuration
sys.path.insert(0, str(HERE.parent / "planning"))
spec = importlib.util.spec_from_file_location("crew_planning_stages", HERE.parent / "planning/stages.py")
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)
from common import digest, fingerprint, inside, read, require, signal, strings, text, write
import validation
sys.path.insert(0, str(HERE.parent / "lane/bin"))
from gates import acceptance_check


class SourceDrift(ValueError):
    pass


def ntk(action, value):
    result = subprocess.run(["node", str(HERE / "ntk.mjs"), action],
                            input=json.dumps(value), capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        try:
            error = json.loads(result.stdout).get("error", {})
        except (ValueError, AttributeError):
            error = {}
        if error.get("code") == "STALE_INPUT":
            raise SourceDrift(error["message"])
    require(result.returncode == 0, result.stderr.strip() or "NTK planning operation failed")
    return json.loads(result.stdout)


def config():
    return configuration(os.environ["PLANNING_CONFIG"])


def lane_state(file):
    state = read(file)
    legacy = file.parent / "result.json"
    if not state.get("result") and legacy.is_file():
        state["result"] = read(legacy)
    return state


def retained(settings, ticket, allow_worktree=False):
    path = Path(settings["sourceRoot"]) / ".worktrees" / ticket
    roots = [Path(settings["stateDir"]) / "crew-dispatchers"]
    for root in roots:
        for file in root.glob("*/runs/*/launch.json"):
            state = lane_state(file)
            if state.get("workspace") != settings["workspace"]:
                continue
            require(not (state.get("ticket") == ticket and not state.get("result")),
                    "A live or unresolved lane owns this ticket; leave it unchanged")
    require(allow_worktree or (not path.exists() and not path.is_symlink()),
            f"WORKTREE PREEXISTED: {path}; cleanup requires a blocked ticket")


def cleanup_blocked(settings, ticket):
    if ticket["status"] != "blocked":
        return
    root = Path(settings["sourceRoot"]).resolve()
    path = root / ".worktrees" / ticket["id"]
    require(not path.parent.is_symlink() and not path.is_symlink(), "Worktree cleanup refuses symlinks")
    if not path.exists():
        return
    require(path.is_dir(), "Worktree cleanup requires a directory")
    component = (ticket.get("module") or "").split("/", 1)[0]
    require(component, "Worktree cleanup needs the ticket module")
    repo = inside(root, component)
    require((repo / ".git").exists(), "Worktree cleanup needs the ticket repository")
    if (path / ".git").exists():
        def origin(directory):
            return subprocess.check_output(["git", "-C", str(directory), "remote", "get-url", "origin"], text=True).strip()
        require(origin(path) in (origin(repo), str(repo), f"/workspace/{root.name}/{component}"),
                "Retained worktree belongs to another repository")
    branch = "ticket-" + ticket["id"]
    require(branch != read(repo / ".ntkrc")["target_branch"], "Worktree cleanup cannot delete the target branch")
    query = subprocess.run(["git", "-C", str(repo), "ls-remote", "--exit-code", "--heads", "origin", "refs/heads/" + branch],
                           capture_output=True, text=True, timeout=120)
    require(query.returncode in (0, 2), query.stderr.strip() or "Cannot check the ticket remote branch")
    if query.returncode == 0:
        subprocess.run(["git", "-C", str(repo), "push", "origin", "--delete", branch], check=True, timeout=120)
    if (path / ".git").is_file():
        subprocess.run(["git", "-C", str(repo), "worktree", "remove", "--force", str(path)], check=True, timeout=120)
    else:
        shutil.rmtree(path)
    print(f"Removed blocked ticket worktree: {path}; remote branch: {branch}", flush=True)


def failure_evidence(settings, ticket):
    runs = []
    for file in (Path(settings["stateDir"]) / "crew-dispatchers").glob("*/runs/*/launch.json"):
        state = lane_state(file)
        if state.get("ticket") == ticket and state.get("workspace") == settings["workspace"] and state.get("result"):
            runs.append(file)
    if not runs:
        return None
    file = max(runs, key=lambda item: item.stat().st_mtime_ns)
    return {"run": str(file.parent), "result": lane_state(file)["result"],
            "artifacts": [str(item) for item in file.parent.glob("lane/*/artifacts")],
            "output": str(file.parent / "output.log")}


def input_key(source, settings, repositories):
    evidence = failure_evidence(settings, source["source"]["ticket"]["id"])
    return digest({"source": source, "failure": evidence, "config": settings,
                   "planning_contract": digest((HERE.parent / "roles/crew-planning-records.jsonl").read_text()),
                   "code": {r["id"]: fingerprint(r) for r in repositories}})


def remember(result):
    target = shared.artifacts()
    if not (target / "input.json").exists():
        return
    settings = config()
    source = ntk("snapshot", {"id": os.environ["PLANNING_TICKET"], "workspace": settings["workspace"]})
    key = input_key(source, settings, read(target / "input.json")["repositories"])
    write(Path(os.environ["PLANNING_STATE"]) / "last.json", {"input_digest": key, **result})


def prepare():
    target = shared.artifacts()
    target.mkdir(parents=True, exist_ok=True)
    settings = config()
    id = os.environ["PLANNING_TICKET"]
    source = ntk("snapshot", {"id": id, "workspace": settings["workspace"]})
    ticket = source["source"]["ticket"]
    require(ticket["status"] in ("open", "blocked"), "Plan only open or blocked tickets; leave active and completed work unchanged")
    retained(settings, id, allow_worktree=ticket["status"] == "blocked")
    cleanup_blocked(settings, ticket)
    projects = shared.indexed_projects()
    registry = {}
    for project in projects:
        if project.get("root_path"):
            registry.setdefault(str(Path(project["root_path"]).resolve()), []).append(project["name"])
    repositories = {}
    root = Path(settings["sourceRoot"]).resolve()
    for module in source["meta"]["modules"]:
        if module.get("archived"):
            continue
        name = module["name"]
        repo_id, _, relative = name.partition("/")
        repo = inside(root, repo_id)
        if not (repo / ".git").exists():
            continue
        require(str(repo) in registry, f"Repository is absent from shared CBM: {repo_id}")
        names = registry[str(repo)]
        canonical = str(repo).lstrip("/").replace("/", "-")
        require(canonical in names or len(names) == 1, f"Ambiguous CBM projects for {repo_id}")
        entry = repositories.setdefault(repo_id, {"id": repo_id, "path": str(repo),
            "cbm_project": canonical if canonical in names else names[0], "modules": []})
        if not any(item["name"] == name for item in entry["modules"]):
            entry["modules"].append({"name": name, "path": relative or "."})
    require(repositories, "NTK has no registered modules under sourceRoot")
    repository_contracts = {key: read(Path(repo["path"]) / ".ntkrc")
                            for key, repo in repositories.items() if (Path(repo["path"]) / ".ntkrc").is_file()}
    key = input_key(source, settings, list(repositories.values()))
    prior = Path(os.environ["PLANNING_STATE"]) / "last.json"
    require(not prior.exists() or read(prior).get("input_digest") != key,
            "This failure and source state were already processed; new evidence or an owner decision is required")
    write(target / "ntk-input.json", source)
    write(target / "config.json", settings)
    evidence = []
    attachments = source["attachments"] + [dict(item, source_ticket=parent["source"]["ticket"]["id"])
        for parent in source.get("parents", []) for item in parent["attachments"]]
    for item in attachments:
        metadata = {key: value for key, value in item.items() if key != "content"}
        if item.get("content") is not None:
            file = target / "ntk-attachments" / (digest(metadata) + ".txt")
            file.parent.mkdir(exist_ok=True)
            file.write_text(item["content"])
            metadata["path"] = str(file)
        else:
            metadata["unread"] = True
        evidence.append(metadata)
    context = {key: value for key, value in source.items() if key not in ("attachments", "parents")}
    context["attachments"] = evidence
    context["parents"] = [parent["source"] for parent in source.get("parents", [])]
    assignment = {"kind": "ntk", "workspace": settings["workspace"], "ticket": ticket,
        "ac": {"id": ticket["id"], "text": ticket.get("body") or ticket["title"]},
        "repositories": list(repositories.values()), "ntk": context,
        "lane_failure": failure_evidence(settings, id),
        "repository_contracts": repository_contracts,
        "gate_commands": settings.get("gateCommands", []),
        # Gate commands run inside the lane, where each configured directory is
        # mounted at /workspace/<name>. Planning runs on the host: read the host path.
        "lane_mounts": lane_mounts(settings),
        "knowledge_query": ticket["title"] + "\n" + (ticket.get("body") or "")}
    write(target / "input.json", assignment)
    limits = context["meta"]["limits"]
    # The designer counts characters badly: ask for a margin under the NTK limit.
    shared.emit_var("OUTPUT_CONTRACT", (HERE / "output.md").read_text()
        .replace("{body_budget}", str(limits["body"] * 85 // 100)).replace("{body_limit}", str(limits["body"]))
        .replace("{title_limit}", str(limits["title"])))
    read_paths = [settings["sourceRoot"], *settings.get("readOnlyRepos", [])]
    if assignment["lane_failure"]:
        read_paths.append(assignment["lane_failure"]["run"])
    shared.prepare_context(assignment, projects, read_paths)


def lane_mounts(settings):
    """Lane path -> host path for every directory the lane mounts by name."""
    dirs = [settings.get("sourceRoot"), *settings.get("readOnlyRepos", []), *settings.get("readWriteDirs", [])]
    return {f"/workspace/{Path(d).name}": str(Path(d).expanduser()) for d in dirs if d}


def verify_checks(body, assignment):
    require(len(re.findall(r"\bTICKET_CHECKS\s*[:=]", body)) == 1,
            "verify_existing body needs exactly one TICKET_CHECKS array")
    marker = re.search(r"\bTICKET_CHECKS\s*[:=]\s*(?:```(?:json)?\s*)?(\[)", body)
    require(marker, "verify_existing body needs TICKET_CHECKS: [JSON checks]")
    try:
        checks, _ = json.JSONDecoder().raw_decode(body[marker.start(1):])
    except json.JSONDecodeError as error:
        raise ValueError(f"TICKET_CHECKS is not valid JSON: {error}") from error
    require(isinstance(checks, list) and checks, "TICKET_CHECKS requires a nonempty array")
    module = assignment["ticket"]["module"]
    repos = [repo for repo in assignment["repositories"]
             if any(item["name"] == module for item in repo["modules"])]
    require(len(repos) == 1, "Verification module must identify one repository")
    root = Path(repos[0]["path"]).resolve()
    for check in checks:
        if isinstance(check, dict):
            acceptance_check(check, root=root)
        else:
            value = text(check, "verification test path")
            inside(root, value)


MAX_DECOMPOSITION_DEPTH = 3


def validate_decomposition(plan, assignment):
    depth = max((item["depth"] for item in assignment["ntk"]["deps"].get("down", [])
                 if not item.get("removed") and item["title"].startswith("[CLOSE AT NO DEPS] ")), default=0)
    require(depth < MAX_DECOMPOSITION_DEPTH,
            "Decomposition depth limit reached; prepare one leaf or return a concrete blocker")
    for key in ("outcome", "necessity", "approach", "rationale"):
        text(plan.get(key), "plan." + key)
    strings(plan.get("alternatives"), "plan.alternatives")
    require(plan.get("blockers") == [], "Blocked work cannot be decomposed")
    require(plan.get("acceptance_checks") == [], "Decomposition does not define executable checks")
    tasks = plan.get("tasks")
    require(isinstance(tasks, list) and len(tasks) >= 2, "Decomposition needs at least two smaller children")
    seen, outcomes, bodies = set(), set(), set()
    repos = {r["id"]: r for r in assignment["repositories"]}
    for task in tasks:
        key = text(task.get("id"), "task.id")
        require(key not in seen, "Duplicate decomposition child")
        require(task.get("ac") == assignment["ac"]["id"], "Child must belong to the source ticket")
        repo = repos.get(task.get("repository"))
        require(repo is not None and any(m["name"] == task.get("module") for m in repo["modules"]),
                "Child module is not in the input registry")
        text(task.get("title"), "child.title")
        outcome = text(task.get("outcome"), "child.outcome")
        require(outcome not in outcomes, "Children must have distinct outcomes")
        body = text(task.get("body"), "child.body")
        require(body != assignment["ticket"].get("body") and body not in bodies,
                "A child must not copy the source or another child")
        dependencies = strings(task.get("depends_on"), "child.depends_on", empty=True)
        require(set(dependencies).issubset(seen), "Children need prerequisite order without cycles")
        require(not any(task.get(field) for field in ("steps", "checks", "write_paths", "reuse", "tasks")),
                "Decompose only one level; prepare each child in a later pass")
        seen.add(key)
        outcomes.add(outcome)
        bodies.add(body)


def validate_plan(plan, assignment):
    verdict = plan.get("ntk", {}).get("verdict")
    require(verdict in ("READY", "NOT_READY", "NEEDS_HUMAN"), "Invalid NTK planning verdict")
    kind = plan["ntk"].get("failure_class")
    require(kind in ("none", "plan", "system", "access", "governance"), "Invalid failure class")
    require(verdict != "READY" or kind in ("none", "plan"), "System, access and governance failures cannot enter the lane queue")
    if verdict != "READY":
        require(plan.get("disposition") == "blocked" and not plan.get("tasks"), "Blocked plan cannot publish Tasks")
        strings(plan.get("blockers"), "plan.blockers")
        if verdict == "NEEDS_HUMAN":
            owner = text(plan["ntk"].get("owner"), "decision owner")
            require(owner in {p["id"] for p in assignment["ntk"]["meta"]["people"] if p.get("kind") == "human"},
                    "Decision owner must be a registered person")
            text(plan["ntk"].get("decision"), "required decision")
        return
    decomposing = plan.get("disposition") == "decompose"
    if decomposing:
        validate_decomposition(plan, assignment)
    else:
        validation.plan(plan, assignment)
        require(plan["disposition"] != "implement" or len(plan["tasks"]) == 1,
                "Prepare one Task per pass; use decompose for several children")
    meta = assignment["ntk"]["meta"]
    limits = meta["limits"]
    allowed = {(m["project"], m["name"]) for m in meta["modules"] if not m.get("archived")}
    prerequisites = {r["ticket"]["id"] for r in assignment["ntk"]["prerequisites"]}
    descendants = {item["id"] for item in assignment["ntk"]["deps"].get("down", [])}
    prerequisites.update(item["ticket"]["id"] for item in assignment["ntk"].get("referenced", [])
                         if item.get("workspace") == assignment["workspace"] and item.get("ticket")
                         and item["ticket"].get("project") in meta["projects"]
                         and not item["ticket"].get("removed") and not item["ticket"].get("removed_at"))
    prerequisites.difference_update(descendants | {assignment["ticket"]["id"]})
    for task in plan["tasks"]:
        require((task.get("project"), task["module"]) in allowed, "Task project/module pair is not registered in NTK")
        body = text(task.get("body"), "Task body")
        require(len(body) <= limits["body"] and len(task["title"]) <= limits["title"],
                f"NTK text limit exceeded in {task.get('id')}: body {len(body)}/{limits['body']}, "
                f"title {len(task['title'])}/{limits['title']} characters; move rationale to the plan report or split the Task")
        strings(task.get("acceptance"), "Task acceptance")
        strings(task.get("covers"), "source acceptance coverage")
        external = strings(task.get("external_dependencies"), "external dependencies", empty=True)
        require(set(external).issubset(prerequisites), "External dependency is not a verified prerequisite or cited ticket")
    if plan["disposition"] == "verify_existing":
        require(assignment["ticket"].get("module"), "Verification needs a source module")
        body = text(plan["ntk"].get("body"), "verification body")
        require(len(body) <= limits["body"], "Verification body exceeds NTK limit")
        verify_checks(body, assignment)


def capture(kind):
    if kind != "plan":
        return shared.capture(kind)
    shared.capture_error_file(kind).unlink(missing_ok=True)
    result, _ = shared.body_result()
    validate_plan(result, read(shared.artifacts() / "input.json"))
    # A valid plan cannot override a research blocker. Keep the ticket blocked
    # and send the diagnosis through the existing critics and publication guards.
    if result["ntk"]["verdict"] == "READY":
        reports = {branch: read(shared.artifacts() / f"research-{branch}.json")
                   for branch in validation.RESEARCH}
        blockers = [f"{branch} research: {claim}"
                    for branch, report in reports.items() if report["status"] == "blocked"
                    for claim in (report["blockers"] or [report["summary"]])]
        if blockers:
            result = {**result, "disposition": "blocked", "tasks": [],
                      "acceptance_checks": [], "blockers": blockers,
                      "ntk": {**result["ntk"], "verdict": "NOT_READY", "failure_class": "plan",
                              "owner": "", "decision": "", "body": ""}}
            validate_plan(result, read(shared.artifacts() / "input.json"))
    write(shared.artifacts() / "plan.json", result)
    signal("PLANNED", "NTK plan validated")


def research_join():
    reports = {key: read(shared.artifacts() / f"research-{key}.json") for key in validation.RESEARCH}
    for key, report in reports.items():
        validation.research(report, key)
    shared.emit_var("research", reports)
    signal("RESEARCHED", "Evidence and missing inputs sent to design")


def review_input():
    plan = read(shared.artifacts() / "plan.json")
    shared.emit_var("plan", plan)
    shared.emit_var("plan_digest", digest(plan))
    signal("REVIEW", "Frozen NTK result sent to independent critics")


def publication_input():
    settings = config()
    require(settings == read(shared.artifacts() / "config.json"), "Configuration changed during planning")
    return {"workspace": settings["workspace"], "snapshot": read(shared.artifacts() / "ntk-input.json"),
        "dispatchTag": settings.get("planning", {}).get("dispatchTag", "crew"), "dispatchTags": settings["tags"],
        "stateDir": os.environ["PLANNING_STATE"], "runId": Path(os.environ["MEDULLA_RUN_DIR"]).name}


def rejected_plan(plan, reviews):
    """The plan critics still reject after the revision round, as a NOT_READY verdict."""
    blockers = [f"{key} critic: {f['claim']} Resolution: {f['resolution']}"
                for key, review in reviews.items() if review["verdict"] == "reject"
                for f in review["findings"] if f["blocking"]]
    if not blockers:
        return None
    return {**plan, "disposition": "blocked", "tasks": [], "blockers": blockers,
            "ntk": {**plan["ntk"], "verdict": "NOT_READY", "failure_class": "plan", "owner": "", "decision": ""}}


def finish():
    target = shared.artifacts()
    assignment, plan = read(target / "input.json"), read(target / "plan.json")
    validate_plan(plan, assignment)
    reviews = {key: read(target / f"critic-{key}.json") for key in validation.CRITICS}
    for review in reviews.values():
        validation.critique(review, digest(plan))
    # A plan the critics still reject is a verdict about the ticket, not a failed
    # run: publish NOT_READY with the findings, so the ticket records why and the
    # dispatcher moves on.
    rejected = rejected_plan(plan, reviews)
    if rejected:
        validate_plan(rejected, assignment)
        shared.verify_freshness(assignment)
        retained(config(), os.environ["PLANNING_TICKET"])
        result = publish(rejected, reviews)
        signal("BLOCKED", json.dumps(result))
        return
    if plan["ntk"]["verdict"] == "READY":
        require(all(read(target / f"research-{branch}.json")["status"] != "blocked"
                    for branch in validation.RESEARCH), "Missing mandatory research cannot produce READY")
    reviews, _, _ = shared.verify_context(assignment, plan)
    retained(config(), os.environ["PLANNING_TICKET"])
    result = publish(plan, reviews)
    signal("READY" if result["verdict"] in ("READY", "DECOMPOSED") else "BLOCKED", json.dumps(result))


def publish(plan, reviews):
    target = shared.artifacts()
    result = ntk("publish", {**publication_input(), "plan": plan, "reviews": reviews,
                             "publicationMarker": str(target / "publication-started.json")})
    # Published on a base the critics cleared after a clean advance: keep the audit trail.
    reviewed = shared.drift.cleared(target)
    if reviewed:
        result = {**result, "drift_review": reviewed}
    write(target / "result.json", result)
    remember(result)
    return result


def fail(reason=None):
    target = shared.artifacts()
    source_drift = isinstance(reason, SourceDrift)
    reason = str(reason or os.environ.get("MEDULLA_LAST_MESSAGE") or "Planning did not complete")
    errors = [read(path) for path in target.glob("error-*.json")]
    if errors:
        reason += "\n" + "\n".join(item["reason"] for item in errors)
    # A run that did not complete has no verdict about the ticket: a tool, an
    # agent or the environment failed. Leave the ticket and the processed-input
    # memory unchanged so the same ticket can be planned again after the fix.
    # Only finish() publishes, after the plan and its critics. A publication that
    # started and failed may have written part of its result: say so, and leave
    # the decision to an operator.
    if (target / "publication-started.json").exists():
        result = {"verdict": "NOT_READY", "reason": reason, "published": False,
                  "ticket_unchanged": False, "publication_uncertain": True}
    else:
        result = {"verdict": "NOT_READY", "reason": reason, "published": False, "ticket_unchanged": True}
        if source_drift:
            result["source_drift"] = True
        # Only the exact freshness failure counts: the source moved while this
        # run planned. Nothing was published, so planning again is safe.
        if reason.split("\n", 1)[0] == shared.CODE_DRIFT:
            result["code_drift"] = True
    write(target / "result.json", result)
    signal("BLOCKED", json.dumps(result))


if __name__ == "__main__":
    command = sys.argv[1]
    try:
        if command == "capture":
            capture(sys.argv[2])
        else:
            {"prepare": prepare, "prepare_critic": shared.prepare_critic, "research_join": research_join, "review_input": review_input,
             "critique_join": shared.critique_join, "finish": finish, "fail": fail}[command]()
    except shared.DriftReview as review:
        signal("DRIFT", review)
    except Exception as error:
        print(f"planning-ntk/{command}: {error}", file=sys.stderr)
        if command in ("capture", "prepare_critic"):
            kind = sys.argv[2] if command == "capture" else "critic"
            file = shared.capture_error_file(kind)
            write(file, {"stage": kind, "branch": file.stem.split("-")[-1], "reason": str(error)})
        else:
            fail(error)
        sys.exit(1)
