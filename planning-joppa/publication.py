"""Validate and publish reviewed Task mechanisms in one Joppa transaction."""
from copy import deepcopy
from pathlib import Path
from uuid import uuid4
import re

from common import digest, read, require, strings, text, write
from mcp import Rejected
import validation


def unclaimed(task):
    process = task["process"]
    require(not process.get("done") and not process.get("retired"),
            "completed or retired Tasks cannot be rewritten")
    require(not process.get("assignee") and not process.get("claim")
            and process.get("status") != "in_progress", "claimed Tasks cannot be rewritten by Crew planning")


def editable(task):
    unclaimed(task)
    require(task["document"]["data"].get("purpose") == "implementation",
            "only implementation Tasks can be rewritten by Crew planning")


def retirable(task):
    unclaimed(task)
    require(isinstance(task["process"].get("blocked"), dict),
            "only blocked Tasks can be retired by Crew planning")


def ensure_recovered(root, current, server, workspace, ac):
    """Refuse another claim while an earlier run needs receipt recovery."""
    for claim_file in Path(root).glob("*/artifacts/claim.json"):
        target = claim_file.parent
        if target.resolve() == current.resolve():
            continue
        claim = read(claim_file)
        args = claim.get("arguments", {})
        if args.get("workspace") != workspace or args.get("command", {}).get("ac") != ac:
            continue
        if claim.get("server") and claim["server"] != server:
            continue
        receipts = [read(target / name) for name in ("claim.json", "publication.json", "release.json")
                    if (target / name).exists()]
        require(not any(item.get("status") in ("pending", "uncertain") for item in receipts),
                f"earlier run needs receipt recovery: {target}")
        if claim.get("status") == "confirmed":
            released = (target / "release.json").exists() and read(target / "release.json").get("status") == "confirmed"
            finished = (target / "result.json").exists() and read(target / "result.json").get("status") == "published"
            require(released or finished, f"earlier claim or publication needs recovery: {target}")


def ordered_tasks(tasks):
    """Order prerequisites before consumers. Reject cycles and duplicate targets."""
    by_id, aliases = {}, {}
    for task in tasks:
        key = text(task.get("id"), "task.id")
        require(key not in by_id and ":" not in key, "local Task IDs must be unique and cannot contain a colon")
        by_id[key] = task
        if task.get("target"):
            require(task["target"] not in aliases, "duplicate Task update target")
            aliases[task["target"]] = key
    result, visiting, done = [], set(), set()
    def visit(key):
        if key in done:
            return
        require(key not in visiting, "planned Task dependencies contain a cycle")
        visiting.add(key)
        for dep in by_id[key].get("depends_on", []):
            local = aliases.get(dep, dep)
            if local in by_id:
                visit(local)
            else:
                require(":" in dep, f"unknown local prerequisite: {dep}")
        visiting.remove(key)
        done.add(key)
        result.append(by_id[key])
    for key in by_id:
        visit(key)
    return result


def validate(plan, assignment):
    normalized = deepcopy(plan)
    normalized["tasks"] = ordered_tasks(normalized.get("tasks", []))
    if normalized.get("disposition") == "verify_existing":
        require(bool(normalized.get("tasks")), "existing behavior requires a scoped verification Task")
        require(any(task.get("action") != "retire" for task in normalized["tasks"]),
                "existing behavior requires a scoped verification Task")
        normalized["disposition"] = "implement"
    inventory = {item["address"]: item for item in assignment["joppa"]["tasks"]}
    known = assignment["joppa"]["objects"]
    targets = set()
    retired = {value for task in normalized["tasks"] if task.get("action") == "retire"
               for value in (task["id"], task.get("target"))}
    for task in normalized.get("tasks", []):
        require(task.get("action") in ("create", "update", "retire"), "Task action must be create, update or retire")
        if task["action"] in ("update", "retire"):
            address = text(task.get("target"), "Task target")
            require(address in inventory and address not in targets, "update must target one existing Task under this AC")
            existing = inventory[address]
            (retirable if task["action"] == "retire" else editable)(existing)
            require(task.get("revision") == existing["current_revision"], "Task source revision differs from the input")
            targets.add(address)
        else:
            require("target" not in task and "revision" not in task, "new Task cannot replace an existing Task")
        if plan.get("disposition") == "verify_existing" and task["action"] != "retire":
            require(task.get("purpose") == "verification", "existing behavior needs verification work only")
        dependencies = strings(task.get("depends_on"), "task.depends_on", empty=True)
        require(not set(dependencies).intersection(retired), "Task cannot depend on a Task retired by this plan")
        require(task["action"] != "retire" or not dependencies, "retirement cannot add dependencies")
        for dep in dependencies:
            if ":" in dep:
                require(dep in known, f"dependency was not read in the criterion context: {dep}")
                require(dep != task.get("target"), "Task cannot depend on itself")
        aliases = {item.get("target"): item["id"] for item in normalized["tasks"] if item.get("target")}
        task["depends_on"] = [aliases.get(dep, dep) for dep in dependencies if ":" not in dep or dep in aliases]
    updates = {task["target"] for task in normalized["tasks"] if task["action"] == "update"}
    for address, existing in inventory.items():
        if address in retired:
            continue
        dependencies = {link["target"] for link in existing["document"].get("links", [])
                        if link.get("blocking") and link.get("relation") == "depends_on"}
        require(not dependencies.intersection(retired) or address in updates,
                f"retirement requires an update that removes the dependency from {address}")
    validation.plan(normalized, assignment)
    require(len(plan.get("tasks", [])) <= 99, "one publication supports at most 99 Task saves")
    schema = assignment["joppa"]["task_schema"]
    limit = schema.get("title_preview_length", 64)
    for task in plan.get("tasks", []):
        require(len(task["title"]) <= limit, f"Task title exceeds the configured {limit}-character limit")


def contract(task, plan):
    lines = [task["outcome"], "", "Approach: " + plan["approach"],
             f"Repository: {task['repository']}", f"Module: {task['module']}", "", "Steps:"]
    lines.extend(f"{number}. " + re.sub(r"^\s*\d+\.\s+", "", step)
                 for number, step in enumerate(task["steps"], 1))
    lines += ["", "Reuse:", *(task["reuse"] or ["No existing mechanism applies."]), "", "Checks:"]
    for check in task["checks"]:
        method = check.get("scenario") or f"{check['command']} (cwd: {check['cwd']})"
        lines.append(method + " => " + check["expected"])
    return "\n".join(lines)


def operations(plan, assignment):
    validate(plan, assignment)
    inventory = {item["address"]: item for item in assignment["joppa"]["tasks"]}
    repositories = {item["id"]: item for item in assignment["repositories"]}
    objects = assignment["joppa"]["objects"]
    schema = assignment["joppa"]["task_schema"]
    result, refs = [], {}
    retired = {task["target"] for task in plan["tasks"] if task["action"] == "retire"}
    aliases = {task["id"]: task["target"] for task in plan["tasks"] if task.get("target")}
    ac = assignment["ac"]["id"]
    owner = objects[ac]["document"]["data"].get("owner")
    require(owner, "criterion owner is required for new Task documents")
    for number, task in enumerate(ordered_tasks(plan["tasks"]), 1):
        existing = inventory.get(task.get("target"))
        if task["action"] == "retire":
            result.append({"command": {"op": "retire_task", "id": existing["address"].split(":", 1)[1],
                "revision": existing["current_revision"], "reason": task["outcome"]}})
            continue
        data = deepcopy(existing["document"]["data"]) if existing else {"owner": owner, "purpose": "implementation"}
        # Joppa execution uses implementation Tasks for both code and scoped verification.
        # Verification evidence remains a separate operation.
        data.update(title=task["title"], contract=contract(task, plan))
        project = repositories[task["repository"]]["project"]
        project_id = project.split(":", 1)[1]
        projects = list(data.get("projects") or [])
        if project_id not in projects:
            if project not in projects:
                projects.append(project_id)
        data["projects"] = projects
        links = deepcopy(existing["document"].get("links", [])) if existing else []
        links = [link for link in links if not (link.get("blocking") and link.get("relation") == "depends_on"
                                                and link.get("target") in retired)]
        for dependency in task["depends_on"]:
            canonical = aliases.get(dependency, dependency)
            if dependency in refs:
                target, revision = {"$ref": refs[dependency] + "/address"}, {"$ref": refs[dependency] + "/saved_revision"}
            else:
                require(canonical in objects, f"unknown dependency: {dependency}")
                target, revision = canonical, objects[canonical]["current_revision"]
            candidate = {"target": target, "revision": revision, "relation": "depends_on", "blocking": True}
            # An explicit dependency in this plan replaces its earlier revision pin.
            links = [link for link in links if not (link.get("relation") == "depends_on"
                                                   and link.get("target") in (canonical, target))]
            links.append(candidate)
        command = {"op": "save_object", "kind": assignment["joppa"]["task_type"],
                   "revision": existing["current_revision"] if existing else 0,
                   "parent": ac, "data": data, "links": links,
                   "reason": "Publish the reviewed mechanism for this criterion.", "question_checked": schema["question"]}
        if existing:
            command["id"] = existing["address"].split(":", 1)[1]
            document = existing["document"]
            if data == document["data"] and links == document["links"] and ac == document["parent"]:
                continue
        ref = "task" + str(number)
        result.append({"ref": ref, "command": command})
        refs[task["id"]] = ref
        if existing:
            refs[existing["address"]] = ref
    result.append({"command": {"op": "finish_planning", "ac": ac,
                               "reason": "Publish reviewed Tasks. The criterion still requires verification."}})
    return result


def mutate(api, target, name, arguments):
    """Record each request before its only attempt. Retain uncertain results."""
    require(not target.exists(), f"mutation already attempted: inspect {target.name}; no automatic retry")
    args = deepcopy(arguments)
    args["request_id"] = "crew-planning-" + str(uuid4())
    record = {"tool": name, "arguments": args, "status": "pending", "server": getattr(api, "url", None)}
    write(target, record)
    try:
        result = api.call(name, args)
    except Rejected as error:
        write(target, {**record, "status": "rejected", "error": str(error)})
        raise
    except Exception as error:
        write(target, {**record, "status": "uncertain", "error": str(error)})
        raise
    write(target, {**record, "status": "confirmed", "result": result})
    return result


def held(api, workspace, address, position, actor=None):
    obj = api.call("joppa_objects", {"workspace": workspace, "address": address})
    claim = obj.get("process", {}).get("planning_claim")
    require(isinstance(claim, dict) and claim.get("position") == position
            and (actor is None or claim.get("actor") == actor), "this run does not hold the planning claim")
    return claim


def release(api, target, workspace, ac, reason):
    claim_file = target / "claim.json"
    if not claim_file.exists():
        return False
    receipt = read(claim_file)
    if receipt["status"] != "confirmed":
        return False
    publication = target / "publication.json"
    if publication.exists() and read(publication)["status"] != "rejected":
        return False
    prior = target / "release.json"
    if prior.exists():
        return read(prior)["status"] == "confirmed"
    held(api, workspace, ac, receipt["result"]["position"], receipt.get("actor"))
    mutate(api, prior, "joppa_command", {"workspace": workspace, "command": {
        "op": "release_planning", "ac": ac, "reason": reason[:2000]}})
    return True
