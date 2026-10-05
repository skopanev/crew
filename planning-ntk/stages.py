"""NTK entry and publication stages for the shared planning graph."""
import json
import importlib.util
import os
from pathlib import Path
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


def ntk(action, value):
    result = subprocess.run(["node", str(HERE / "ntk.mjs"), action],
                            input=json.dumps(value), capture_output=True, text=True, timeout=600)
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


def retained(settings, ticket):
    path = Path(settings["sourceRoot"]) / ".worktrees" / ticket
    require(not path.exists() and not path.is_symlink(), f"WORKTREE PREEXISTED: {path}; operator cleanup required")
    roots = [Path(settings["stateDir"]) / "crew-dispatchers"]
    for root in roots:
        for file in root.glob("*/runs/*/launch.json"):
            state = lane_state(file)
            if state.get("workspace") != settings["workspace"]:
                continue
            require(not (state.get("ticket") == ticket and not state.get("result")),
                    "A live or unresolved lane owns this ticket; leave it unchanged")


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
    retained(settings, id)
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
    for item in source["attachments"]:
        metadata = {key: value for key, value in item.items() if key != "content"}
        if item.get("content") is not None:
            file = target / "ntk-attachments" / (digest(metadata) + ".txt")
            file.parent.mkdir(exist_ok=True)
            file.write_text(item["content"])
            metadata["path"] = str(file)
        else:
            metadata["unread"] = True
        evidence.append(metadata)
    context = {key: value for key, value in source.items() if key != "attachments"}
    context["attachments"] = evidence
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
            title = "[HUMAN] " + assignment["ticket"]["title"].removeprefix("[HUMAN] ")
            require(len(title) <= assignment["ntk"]["meta"]["limits"]["title"],
                    "Human decision title exceeds the NTK limit; shorten it before planning")
        return
    validation.plan(plan, assignment)
    meta = assignment["ntk"]["meta"]
    limits = meta["limits"]
    allowed = {(m["project"], m["name"]) for m in meta["modules"] if not m.get("archived")}
    prerequisites = {r["ticket"]["id"] for r in assignment["ntk"]["prerequisites"]}
    for task in plan["tasks"]:
        require((task.get("project"), task["module"]) in allowed, "Task project/module pair is not registered in NTK")
        body = text(task.get("body"), "Task body")
        require(len(body) <= limits["body"] and len(task["title"]) <= limits["title"],
                f"NTK text limit exceeded in {task.get('id')}: body {len(body)}/{limits['body']}, "
                f"title {len(task['title'])}/{limits['title']} characters; move rationale to the plan report or split the Task")
        require(len(set(task["write_paths"])) <= 10, "Task exceeds the ten-file budget; split it")
        strings(task.get("acceptance"), "Task acceptance")
        strings(task.get("covers"), "source acceptance coverage")
        external = strings(task.get("external_dependencies"), "external dependencies", empty=True)
        require(set(external).issubset(prerequisites), "External dependency is not in the verified prerequisite graph")
    if plan["disposition"] == "verify_existing":
        require(assignment["ticket"].get("module"), "Verification needs a source module")
        require(len(text(plan["ntk"].get("body"), "verification body")) <= limits["body"], "Verification body exceeds NTK limit")
    if len(plan["tasks"]) > 1 or any(t["project"] != assignment["ticket"]["project"] for t in plan["tasks"]):
        require(len("[CLOSE AT NO DEPS] " + assignment["ticket"]["title"].removeprefix("[HUMAN] ")) <= limits["title"], "Coordinator title exceeds NTK limit")


def capture(kind):
    if kind != "plan":
        return shared.capture(kind)
    shared.capture_error_file(kind).unlink(missing_ok=True)
    result, _ = shared.body_result()
    validate_plan(result, read(shared.artifacts() / "input.json"))
    # Checked here, not only in finish(): a vetoed design retries with this reason
    # in its prompt, so a blocked research report turns into NEEDS_HUMAN or
    # NOT_READY instead of a READY that finish() can only refuse.
    if result["ntk"]["verdict"] == "READY":
        blocked = [branch for branch in validation.RESEARCH
                   if read(shared.artifacts() / f"research-{branch}.json")["status"] == "blocked"]
        require(not blocked, f"Research is blocked ({', '.join(blocked)}): READY is not allowed. "
                "Return NEEDS_HUMAN with the exact owner decision, or NOT_READY with the missing fact.")
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
    signal("READY" if result["verdict"] == "READY" else "BLOCKED", json.dumps(result))


def publish(plan, reviews):
    # The marker is written before the first NTK write. If publication then
    # fails, fail() cannot claim the ticket is unchanged.
    target = shared.artifacts()
    write(target / "publication-started.json", {"plan_digest": digest(plan)})
    result = ntk("publish", {**publication_input(), "plan": plan, "reviews": reviews})
    write(target / "result.json", result)
    remember(result)
    return result


def fail(reason=None):
    target = shared.artifacts()
    reason = reason or os.environ.get("MEDULLA_LAST_MESSAGE") or "Planning did not complete"
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
    write(target / "result.json", result)
    signal("BLOCKED", json.dumps(result))


if __name__ == "__main__":
    command = sys.argv[1]
    try:
        if command == "capture":
            capture(sys.argv[2])
        else:
            {"prepare": prepare, "research_join": research_join, "review_input": review_input,
             "critique_join": shared.critique_join, "finish": finish, "fail": fail}[command]()
    except Exception as error:
        print(f"planning-ntk/{command}: {error}", file=sys.stderr)
        if command == "capture":
            file = shared.capture_error_file(sys.argv[2])
            write(file, {"stage": sys.argv[2], "branch": file.stem.split("-")[-1], "reason": str(error)})
        else:
            fail(str(error))
        sys.exit(1)
